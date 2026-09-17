import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildManifest, hashPieceId } from "../../packages/manifest/index.js";
import { createManifestStore, ManifestConflictError, type ManifestStore } from "../../packages/manifest/store.js";
import type { P2PNodeAddress, P2PTransport } from "../../packages/p2p/index.js";
import type { StorageNodeEndpoint, CoordinatorEndpointProvider } from "./index.js";
import { repairManifestReplica, RepairError } from "./repair.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function endpoint(id: string, availableBytes = 1_000): StorageNodeEndpoint {
  return {
    id,
    baseUrl: `http://${id}.invalid`,
    transport: "http",
    capacity: { usedBytes: 0, availableBytes },
    capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, maxPieceBytes: 10_000 },
  };
}

function makeCoordinator(available: StorageNodeEndpoint[], known = available): CoordinatorEndpointProvider {
  return {
    async refresh() { return available.map((value) => ({ ...value })); },
    getEndpoints() { return available.map((value) => ({ ...value })); },
    getKnownEndpoints() { return known.map((value) => ({ ...value })); },
  };
}

function makeTransport(pieces: Map<string, Map<string, Buffer>>): P2PTransport {
  const mapFor = (node: P2PNodeAddress) => {
    let map = pieces.get(node.nodeId);
    if (!map) {
      map = new Map();
      pieces.set(node.nodeId, map);
    }
    return map;
  };
  return {
    protocol: "http",
    async health() { return { available: true, capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true } }; },
    async getPiece(node, pieceId) {
      const data = mapFor(node).get(pieceId);
      return data ? { status: 200, bytes: Buffer.from(data) } : { status: 404 };
    },
    async storePiece(node, pieceId, data) {
      mapFor(node).set(pieceId, Buffer.from(data));
      return { status: 201 };
    },
    async deletePiece(node, pieceId) {
      mapFor(node).delete(pieceId);
      return { status: 204 };
    },
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "openstore-repair-"));
  dirs.push(dir);
  const piece = Buffer.from("opaque encrypted piece");
  const pieceId = hashPieceId(piece);
  const a = endpoint("node-a");
  const b = endpoint("node-b");
  const c = endpoint("node-c");
  const manifest = buildManifest({
    fileId: "repair-file",
    filename: "repair.bin",
    size: 1,
    chunkSize: 1,
    cryptoVersion: 1,
    chunks: [{ index: 0, pieceId, plaintextHash: "a".repeat(64), plaintextSize: 1, encryptedSize: piece.length, nodeIds: [a.id, b.id] }],
  });
  const store = createManifestStore({ dir });
  await store.save(manifest);
  const pieces = new Map<string, Map<string, Buffer>>([[a.id, new Map([[pieceId, piece]])]]);
  return { store, manifest, piece, pieceId, a, b, c, pieces };
}

describe("explicit replica repair (048B)", () => {
  it("observes confirmed loss and atomically replaces the lost replica", async () => {
    const state = await setup();
    const report = await repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.a, state.c], [state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      observationCount: 2,
      observationIntervalMs: 0,
      gracePeriodMs: 0,
      transport: makeTransport(state.pieces),
    });
    expect(report.chunks[0]).toMatchObject({ removedNodeId: "node-b", addedNodeId: "node-c", sourceNodeId: "node-a" });
    expect(report.manifest.chunks[0].nodeIds).toEqual(["node-a", "node-c"]);
    expect(state.pieces.get("node-c")?.get(state.pieceId)).toEqual(state.piece);
    expect((await state.store.loadWithRevision(state.manifest.fileId))?.revision).toBe(2);
  });

  it("aborts when the lost node reappears", async () => {
    const state = await setup();
    await expect(repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      observationCount: 1,
      observationIntervalMs: 0,
      transport: makeTransport(state.pieces),
    })).rejects.toMatchObject({ classification: "failed" });
  });

  it("uses only manifest-listed sources and rejects corrupt source bytes", async () => {
    const state = await setup();
    state.pieces.set("node-a", new Map([[state.pieceId, Buffer.from("corrupt")]]));
    const c = endpoint("node-c");
    await expect(repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.c], [state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      observationCount: 1,
      observationIntervalMs: 0,
      transport: makeTransport(state.pieces),
    })).rejects.toMatchObject({ classification: "source-corrupt" });
    expect(state.pieces.get(c.id)).toBeUndefined();
  });

  it("filters targets by capability and capacity", async () => {
    const state = await setup();
    const bad = { ...endpoint("bad", 1), capabilities: { ...endpoint("bad").capabilities!, pieceStore: false } };
    await expect(repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.a, bad], [state.a, state.b, bad]),
      lostNodeId: state.b.id,
      observationCount: 1,
      observationIntervalMs: 0,
      transport: makeTransport(state.pieces),
    })).rejects.toMatchObject({ classification: "target-unavailable" });
  });

  it("does not select a target from stale data when the coordinator is unavailable", async () => {
    const state = await setup();
    const coordinator: CoordinatorEndpointProvider = {
      async refresh() { throw new Error("coordinator unavailable"); },
      getEndpoints() { return [state.a, state.c]; },
      getKnownEndpoints() { return [state.a, state.b, state.c]; },
    };
    await expect(repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator,
      lostNodeId: state.b.id,
      observationCount: 1,
      transport: makeTransport(state.pieces),
    })).rejects.toMatchObject({ classification: "coordinator-unavailable" });
    expect((await state.store.load(state.manifest.fileId))?.chunks[0].nodeIds).toEqual(["node-a", "node-b"]);
  });

  it("leaves the manifest unchanged when the target cannot store", async () => {
    const state = await setup();
    const base = makeTransport(state.pieces);
    const transport: P2PTransport = {
      ...base,
      async storePiece(node, pieceId, data, request) {
        if (node.nodeId === "node-c") return { status: 503 };
        return base.storePiece(node, pieceId, data, request);
      },
    };
    await expect(repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.a, state.c], [state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      observationCount: 1,
      transport,
      retryAttempts: 1,
    })).rejects.toMatchObject({ classification: "target-unavailable" });
    expect((await state.store.load(state.manifest.fileId))?.chunks[0].nodeIds).toEqual(["node-a", "node-b"]);
  });

  it("cancels before mutation and does not expose repair secrets", async () => {
    const state = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.a, state.c], [state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      signal: controller.signal,
      observationCount: 1,
      transport: makeTransport(state.pieces),
    })).rejects.toMatchObject({ classification: "cancelled" });
    expect((await state.store.load(state.manifest.fileId))?.chunks[0].nodeIds).toEqual(["node-a", "node-b"]);
    expect(() => JSON.stringify(new RepairError("failed", state.manifest.fileId, "safe failure"))).not.toThrow();
  });

  it("treats an exact existing target as idempotent", async () => {
    const state = await setup();
    state.pieces.set("node-c", new Map([[state.pieceId, state.piece]]));
    const report = await repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.a, state.c], [state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      observationCount: 1,
      observationIntervalMs: 0,
      transport: makeTransport(state.pieces),
    });
    expect(report.manifest.chunks[0].nodeIds).toEqual(["node-a", "node-c"]);
  });

  it("fails closed on mismatched target bytes", async () => {
    const state = await setup();
    state.pieces.set("node-c", new Map([[state.pieceId, Buffer.from("wrong")]]));
    await expect(repairManifestReplica(state.manifest.fileId, {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.a, state.c], [state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      observationCount: 1,
      observationIntervalMs: 0,
      transport: makeTransport(state.pieces),
    })).rejects.toMatchObject({ classification: "failed" });
    expect((await state.store.load(state.manifest.fileId))?.chunks[0].nodeIds).toEqual(["node-a", "node-b"]);
  });

  it("coalesces concurrent repairs for the same file and piece", async () => {
    const state = await setup();
    const options = {
      manifestStore: state.store,
      coordinator: makeCoordinator([state.a, state.c], [state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      observationCount: 1,
      observationIntervalMs: 0,
      transport: makeTransport(state.pieces),
    };
    const [first, second] = await Promise.all([
      repairManifestReplica(state.manifest.fileId, options),
      repairManifestReplica(state.manifest.fileId, options),
    ]);
    expect(first.manifest.chunks[0].nodeIds).toEqual(second.manifest.chunks[0].nodeIds);
    expect((await state.store.loadWithRevision(state.manifest.fileId))?.revision).toBe(2);
  });

  it("reconciles a bounded manifest conflict without blind overwrite", async () => {
    const state = await setup();
    const original = state.store.saveIfRevision.bind(state.store);
    let conflicted = false;
    const wrapped: ManifestStore = {
      ...state.store,
      async saveIfRevision(fileId, revision, next) {
        if (!conflicted) {
          conflicted = true;
          throw new ManifestConflictError(fileId, revision, revision + 1);
        }
        return original(fileId, revision, next);
      },
    };
    const report = await repairManifestReplica(state.manifest.fileId, {
      manifestStore: wrapped,
      coordinator: makeCoordinator([state.a, state.c], [state.a, state.b, state.c]),
      lostNodeId: state.b.id,
      observationCount: 1,
      observationIntervalMs: 0,
      transport: makeTransport(state.pieces),
    });
    expect(report.manifest.chunks[0].nodeIds).toEqual(["node-a", "node-c"]);
  });
});
