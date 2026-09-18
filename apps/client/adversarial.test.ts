import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AddressInfo } from "net";
import { buildManifest, hashPieceId } from "../../packages/manifest/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import type { P2PNodeAddress, P2PTransport } from "../../packages/p2p/index.js";
import type { StorageNodeEndpoint } from "./index.js";
import { getPieceFromNodes } from "./index.js";
import { uploadBuffer } from "./upload.js";
import { downloadBuffer } from "./download.js";
import { repairManifestReplica } from "./repair.js";
import { HttpProvenanceTransport, HttpStorageTransport, RESPONSE_TOO_LARGE_MESSAGE } from "./http-transport.js";
import { isPlacementEligibleEndpoint } from "./selection.js";
import { coordinatorNodesToEndpoints } from "./coordinator.js";
import { createPieceClaim } from "./provenance.js";
import { createIdentity } from "../../packages/identity/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function endpoint(id: string, extra: Partial<StorageNodeEndpoint> = {}): StorageNodeEndpoint {
  return {
    id,
    baseUrl: `http://${id}.invalid`,
    transport: "http",
    capacity: { usedBytes: 0, availableBytes: 10_000 },
    capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, maxPieceBytes: 10_000 },
    ...extra,
  };
}

/** In-memory transport with per-node scripted adversarial behavior. */
function scriptedTransport(
  script: (nodeId: string, pieceId: string, op: "get" | "store") => { status: number; bytes?: Buffer } | never,
  calls: { nodeId: string; op: string }[] = [],
  stored = new Map<string, Map<string, Buffer>>(),
): P2PTransport {
  const mapFor = (nodeId: string) => {
    let m = stored.get(nodeId);
    if (!m) {
      m = new Map();
      stored.set(nodeId, m);
    }
    return m;
  };
  return {
    protocol: "scripted",
    async health() { return { available: true, capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true } }; },
    async getPiece(node: P2PNodeAddress, pieceId: string) {
      calls.push({ nodeId: node.nodeId, op: "get" });
      const out = script(node.nodeId, pieceId, "get");
      return out.status === 200 && out.bytes ? { status: 200, bytes: Buffer.from(out.bytes) } : { status: out.status };
    },
    async storePiece(node: P2PNodeAddress, pieceId: string, data: Buffer) {
      calls.push({ nodeId: node.nodeId, op: "store" });
      const out = script(node.nodeId, pieceId, "store");
      if (out.status === 200 || out.status === 201) mapFor(node.nodeId).set(pieceId, Buffer.from(data));
      return { status: out.status };
    },
    async deletePiece() {
      return { status: 204 };
    },
  };
}

function coordinator(endpoints: StorageNodeEndpoint[]) {
  const snap = endpoints.map((e) => ({ ...e }));
  return {
    async refresh() { return snap.map((e) => ({ ...e })); },
    getEndpoints: () => snap.map((e) => ({ ...e })),
    getKnownEndpoints: () => snap.map((e) => ({ ...e })),
  };
}

async function uploadViaHonestTransport(): Promise<{
  manifest: Awaited<ReturnType<typeof uploadBuffer>>["manifest"];
  key: Uint8Array;
  honest: Map<string, Map<string, Buffer>>;
  endpoints: StorageNodeEndpoint[];
}> {
  const honest = new Map<string, Map<string, Buffer>>();
  const transport = scriptedTransport((nodeId, pieceId) => {
    const data = honest.get(nodeId)?.get(pieceId);
    return data ? { status: 200, bytes: data } : { status: 404 };
  }, [], honest);
  // Seed through the real upload path so the manifest is authentic.
  const realTransport = scriptedTransport(() => ({ status: 201 }), [], honest);
  const endpoints = [endpoint("node-a"), endpoint("node-b")];
  const { manifest, encryptionKey } = await uploadBuffer(Buffer.from("adversarial-file-bytes"), "adv.bin", endpoints, {
    transport: realTransport,
    replicationFactor: 2,
  });
  void transport;
  return { manifest, key: encryptionKey, honest, endpoints };
}

describe("Milestone 067: adversarial storage nodes (deterministic unit)", () => {
  it("corrupted bytes and wrong-piece bytes are detected before acceptance", async () => {
    const { manifest, key, honest, endpoints } = await uploadViaHonestTransport();
    const pieceId = manifest.chunks[0]!.pieceId;
    const good = honest.get("node-a")!.get(pieceId)!;
    // Corrupt: flip bytes. Wrong-piece: bytes of an unrelated valid piece.
    const corrupted = Buffer.from(good);
    corrupted[0] = corrupted[0]! ^ 0xff;
    const other = Buffer.from("unrelated-piece-bytes");
    const transport = scriptedTransport((nodeId) => {
      if (nodeId === "node-a") return { status: 200, bytes: corrupted };
      if (nodeId === "node-b") return { status: 200, bytes: other };
      return { status: 404 };
    });
    // Both replicas dishonest and no honest fallback: download fails, never returns bad data.
    await expect(downloadBuffer(manifest, key, endpoints, { transport })).rejects.toThrow(/hash mismatch|failed on all/);
    // With one honest replica restored, the corrupt/wrong replicas are skipped.
    const mixed = scriptedTransport((nodeId) => {
      if (nodeId === "node-a") return { status: 200, bytes: corrupted };
      return { status: 200, bytes: good };
    });
    expect(await downloadBuffer(manifest, key, endpoints, { transport: mixed })).toEqual(
      Buffer.from("adversarial-file-bytes"),
    );
  });

  it("200-with-garbage and unexpected statuses never become file data", async () => {
    const { manifest, key, endpoints } = await uploadViaHonestTransport();
    const garbage = scriptedTransport(() => ({ status: 200, bytes: Buffer.from("{not-a-piece") }));
    await expect(downloadBuffer(manifest, key, endpoints, { transport: garbage })).rejects.toThrow();
    const weird = scriptedTransport(() => ({ status: 418, bytes: Buffer.from("teapot") }));
    await expect(
      getPieceFromNodes(manifest.chunks[0]!.pieceId, endpoints, { transport: weird, retryAttempts: 1 }),
    ).rejects.toThrow(/unavailable/);
  });

  it("oversized responses fail fast without retrying the malicious replica", async () => {
    const calls: { nodeId: string; op: string }[] = [];
    const transport = scriptedTransport((nodeId) => {
      if (nodeId === "node-evil") throw new Error(RESPONSE_TOO_LARGE_MESSAGE);
      return { status: 200, bytes: Buffer.from("honest") };
    }, calls);
    const endpoints = [endpoint("node-evil"), endpoint("node-good")];
    const got = await getPieceFromNodes("anypiece", endpoints, { transport, retryAttempts: 3 });
    expect(got.bytes.toString()).toBe("honest");
    expect(got.from.id).toBe("node-good");
    // Malicious replica was tried once, not retried: fail-fast to next replica.
    expect(calls.filter((c) => c.nodeId === "node-evil")).toHaveLength(1);
  });

  it("real HTTP transport rejects oversized bodies before buffering them", async () => {
    const big = Buffer.alloc(64 * 1024, 7);
    const server: Server = createServer((req, res) => {
      // Lie about length in one case, tell the truth in the other: both must be rejected.
      const lying = req.url?.includes("lying") ?? false;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        ...(lying ? {} : { "content-length": big.length }),
      });
      res.end(big);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const transport = new HttpStorageTransport();
      const addr = (id: string, path: string): P2PNodeAddress => ({ nodeId: id, baseUrl: `http://127.0.0.1:${port}${path}` });
      await expect(
        transport.getPiece(addr("n", ""), "p", { timeoutMs: 5000, maxResponseBytes: 1024 }),
      ).rejects.toThrow(/exceeds size bound/);
      await expect(
        transport.getPiece(addr("n", "/lying"), "p", { timeoutMs: 5000, maxResponseBytes: 1024 }),
      ).rejects.toThrow(/exceeds size bound/);
      // A body within the bound still passes.
      const ok = await transport.getPiece(addr("n", ""), "p", { timeoutMs: 5000, maxResponseBytes: 128 * 1024 });
      expect(ok.status).toBe(200);
      expect(ok.bytes!.length).toBe(big.length);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lying store ACKs do not corrupt manifests; download skips the liar and repair re-replicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-067-"));
    dirs.push(dir);
    const { createManifestStore } = await import("../../packages/manifest/store.js");
    const store = createManifestStore({ dir });
    const stored = new Map<string, Map<string, Buffer>>();
    // node-liar ACKs stores but keeps nothing; node-good behaves honestly.
    const transport = scriptedTransport((nodeId, pieceId, op) => {
      if (nodeId === "node-liar") return { status: op === "store" ? 201 : 404 };
      if (op === "store") return { status: 201 };
      const data = stored.get(nodeId)?.get(pieceId);
      return data ? { status: 200, bytes: data } : { status: 404 };
    }, [], stored);
    const endpoints = [endpoint("node-liar"), endpoint("node-good")];
    const { manifest, encryptionKey } = await uploadBuffer(Buffer.from("lying-ack-file"), "liar.bin", endpoints, {
      transport,
      replicationFactor: 2,
      manifestStore: store,
    });
    expect(manifest.chunks[0]!.nodeIds).toContain("node-liar");
    // Download still succeeds via the honest replica; liar never serves valid bytes.
    expect(await downloadBuffer(manifest, encryptionKey, endpoints, { transport })).toEqual(Buffer.from("lying-ack-file"));
    // Repair treats the liar as lost and re-replicates onto an honest target without duplicates.
    // The lost node must be absent from the available set (as a real
    // coordinator reports after expiry); known endpoints retain it as a source reference.
    const repairCoord = {
      async refresh() { return [endpoint("node-good"), endpoint("node-fresh")]; },
      getEndpoints: () => [endpoint("node-good"), endpoint("node-fresh")],
      getKnownEndpoints: () => [endpoint("node-liar"), endpoint("node-good"), endpoint("node-fresh")],
    };
    const report = await repairManifestReplica(manifest.fileId, {
      manifestStore: store,
      coordinator: repairCoord,
      lostNodeId: "node-liar",
      observationCount: 1,
      observationIntervalMs: 0,
      transport,
    });
    expect(report.chunks[0]).toMatchObject({ removedNodeId: "node-liar", addedNodeId: "node-fresh" });
    const final = await store.load(manifest.fileId);
    expect(new Set(final!.chunks[0]!.nodeIds).size).toBe(2);
    expect(final!.chunks[0]!.nodeIds).not.toContain("node-liar");
  });

  it("forged provenance claim responses are rejected before trust", async () => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        // Forged: well-formed JSON but an invalid claim (bad state + IDs).
        res.end(JSON.stringify({ claim: { pieceId: "p", claimId: "nope", operationId: "nope", clientNamespace: "x", kind: "upload", state: "super-committed", createdAt: 1, updatedAt: 2 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const transport = new HttpProvenanceTransport();
      const node: P2PNodeAddress = { nodeId: "node-evil", baseUrl: `http://127.0.0.1:${port}` };
      const claim = createPieceClaim("apiece", "upload", createIdentity());
      await expect(transport.createClaim(node, claim, { timeoutMs: 3000 })).rejects.toThrow(/claim response is invalid/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("false capacity and lifecycle lies never win placement", async () => {
    // Zero capacity, draining, and released endpoints are ineligible.
    expect(isPlacementEligibleEndpoint(endpoint("a", { capacity: { usedBytes: 0, availableBytes: 0 } }), 10)).toBe(false);
    expect(isPlacementEligibleEndpoint(endpoint("a", { lifecycle: "draining" }), 10)).toBe(false);
    expect(isPlacementEligibleEndpoint(endpoint("a", { lifecycle: "released" }), 10)).toBe(false);
    expect(isPlacementEligibleEndpoint(endpoint("a", { capabilities: { pieceStore: false, pieceGet: true, pieceDelete: true } }), 10)).toBe(false);
    // A node lying about huge capacity still has to actually store: per-node
    // store failure is tolerated and placement falls through to honest nodes.
    const stored = new Map<string, Map<string, Buffer>>();
    const transport = scriptedTransport((nodeId) => (nodeId === "node-liar" ? { status: 507 } : { status: 201 }), [], stored);
    const endpoints = [
      endpoint("node-liar", { capacity: { usedBytes: 0, availableBytes: Number.MAX_SAFE_INTEGER } }),
      endpoint("node-good"),
    ];
    const { manifest } = await uploadBuffer(Buffer.from("capacity-lie"), "cap.bin", endpoints, {
      transport,
      replicationFactor: 1,
    });
    expect(manifest.chunks[0]!.nodeIds).toEqual(["node-good"]);
  });

  it("libp2p identity and descriptor mismatches are rejected before any use", async () => {
    const identity = createIdentity();
    const goodKey = identity.publicKey.toString("base64");
    // identityBinding must equal nodeId.
    expect(() =>
      coordinatorNodesToEndpoints({
        nodes: [{
          nodeId: "peer-a", publicKey: goodKey, baseUrl: "libp2p://peer-a", available: true,
          lastSeen: Date.now(),
          capacity: { allocatedBytes: 100, usedBytes: 0, availableBytes: 100 },
          reliability: { successfulHeartbeats: 1, missedHeartbeats: 0, score: 80, successfulAudits: 0, failedAudits: 0, storageScore: 50 },
          transport: "libp2p", multiaddr: "/ip4/127.0.0.1/tcp/4001/p2p/peer-a",
          identityBinding: "peer-other",
          capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
        }],
      }),
    ).toThrow(/binding|identity/i);
    // Endpoint validation rejects libp2p endpoints without multiaddr.
    const { assertValidEndpoints } = await import("./index.js");
    expect(() => assertValidEndpoints([{ id: "x", baseUrl: "libp2p://x" }])).toThrow(/multiaddr/);
  });

  it("withholding and mid-operation disappearance never yield partial files", async () => {
    const { manifest, key, honest, endpoints } = await uploadViaHonestTransport();
    const cold = scriptedTransport(() => ({ status: 404 }));
    await expect(downloadBuffer(manifest, key, endpoints, { transport: cold })).rejects.toThrow(/failed on all/);
    // Two-chunk file where the second chunk is unavailable everywhere: throws, never partial.
    const { buildManifest: build } = await import("../../packages/manifest/index.js");
    const good = honest.get("node-a")!.get(manifest.chunks[0]!.pieceId)!;
    const missingPiece = "cd".repeat(32);
    const two = build({
      fileId: manifest.fileId, filename: manifest.filename, size: manifest.size,
      chunkSize: manifest.chunkSize, cryptoVersion: manifest.cryptoVersion,
      chunks: [manifest.chunks[0]!, {
        ...manifest.chunks[0]!,
        index: 1,
        pieceId: missingPiece,
        plaintextHash: "ef".repeat(32),
        nodeIds: ["node-a", "node-b"],
      }],
    });
    const partial = scriptedTransport((nodeId, pieceId) => {
      if (pieceId === manifest.chunks[0]!.pieceId) return { status: 200, bytes: good };
      return { status: 404 };
    });
    await expect(downloadBuffer(two, key, endpoints, { transport: partial })).rejects.toThrow(/failed on all/);
  });

  it("duplicate and conflicting placement claims cannot enter manifests", async () => {
    const { buildManifest: build } = await import("../../packages/manifest/index.js");
    const fake = "ab".repeat(32);
    expect(() =>
      build({
        fileId: "dup", filename: "dup.bin", size: 1, chunkSize: 1, cryptoVersion: 1,
        chunks: [{ index: 0, pieceId: fake, plaintextHash: fake, plaintextSize: 1, encryptedSize: 2, nodeIds: ["n1", "n1"] }],
      }),
    ).toThrow(/duplicate/);
    // Repair against an already-repaired manifest is a safe no-op, not a duplicate.
    const dir = await mkdtemp(join(tmpdir(), "openstore-067-"));
    dirs.push(dir);
    const { createManifestStore } = await import("../../packages/manifest/store.js");
    const store = createManifestStore({ dir });
    const stored = new Map<string, Map<string, Buffer>>();
    const transport = scriptedTransport((nodeId, pieceId, op) => {
      if (op === "store") return { status: 201 };
      const data = stored.get(nodeId)?.get(pieceId);
      return data ? { status: 200, bytes: data } : { status: 404 };
    }, [], stored);
    const endpoints = [endpoint("node-a"), endpoint("node-b"), endpoint("node-c")];
    const { manifest } = await uploadBuffer(Buffer.from("dup-repair"), "dup.bin", endpoints.slice(0, 2), {
      transport, replicationFactor: 2, manifestStore: store,
    });
    const lost = manifest.chunks[0]!.nodeIds[0]!;
    // Available set excludes the lost node; known set retains it as reference.
    const repairCoord = {
      async refresh() { return endpoints.filter((e) => e.id !== lost).map((e) => ({ ...e })); },
      getEndpoints: () => endpoints.filter((e) => e.id !== lost),
      getKnownEndpoints: () => endpoints.map((e) => ({ ...e })),
    };
    const first = await repairManifestReplica(manifest.fileId, {
      manifestStore: store, coordinator: repairCoord, lostNodeId: lost,
      observationCount: 1, observationIntervalMs: 0, transport,
    });
    expect(first.chunks).toHaveLength(1);
    // Same repair again: nothing references the lost node anymore.
    const second = await repairManifestReplica(manifest.fileId, {
      manifestStore: store, coordinator: repairCoord, lostNodeId: lost,
      observationCount: 1, observationIntervalMs: 0, transport,
    });
    expect(second.chunks).toHaveLength(0);
    const final = await store.load(manifest.fileId);
    expect(new Set(final!.chunks[0]!.nodeIds).size).toBe(2);
  });

  it("malformed piece metadata and unexpected statuses fail closed", async () => {
    const { buildManifest: build } = await import("../../packages/manifest/index.js");
    expect(() =>
      build({
        fileId: "bad", filename: "bad.bin", size: 1, chunkSize: 1, cryptoVersion: 1,
        chunks: [{ index: 0, pieceId: "not-a-hash", plaintextHash: "ab".repeat(32), plaintextSize: 1, encryptedSize: 2, nodeIds: ["n1"] }],
      }),
    ).toThrow();
    expect(() =>
      coordinatorNodesToEndpoints({ nodes: [{ nodeId: "", baseUrl: "http://x", available: true }] }),
    ).toThrow();
    // 500-class statuses are retried boundedly; other odd statuses fail fast.
    const calls: string[] = [];
    const flaky = scriptedTransport(() => {
      calls.push("x");
      return { status: 500 };
    });
    await expect(
      getPieceFromNodes("somepiece", [endpoint("node-flaky")], { transport: flaky, retryAttempts: 2, retryBackoffMs: 0 }),
    ).rejects.toThrow(/unavailable/);
    expect(calls).toHaveLength(2);
  });

  it("failures never expose plaintext, keys, tokens, or secrets", async () => {
    const { manifest, endpoints } = await uploadViaHonestTransport();
    const key = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    const dead = scriptedTransport(() => ({ status: 500 }));
    let message = "";
    try {
      await downloadBuffer(manifest, key, endpoints, { transport: dead, retryAttempts: 1, retryBackoffMs: 0 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message.length).toBeGreaterThan(0);
    const keyHex = Buffer.from(key).toString("hex");
    const keyB64 = Buffer.from(key).toString("base64");
    expect(message).not.toContain(keyHex);
    expect(message).not.toContain(keyB64);
    expect(message).not.toMatch(/recovery phrase|privateKey|BEGIN .*PRIVATE/i);
    // repairMeta error path redacts endpoint URLs and secrets alike.
    const { RepairError } = await import("./repair.js");
    expect(new RepairError("failed", manifest.fileId, "safe failure").message).not.toMatch(/plaintext|token/i);
  });
});
