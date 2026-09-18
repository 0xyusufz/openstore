import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildManifest, hashPieceId } from "../../packages/manifest/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import type { StorageNodeEndpoint } from "./index.js";
import { RepairError } from "./repair.js";
import { createRepairScheduler, type RepairSchedulerEvent } from "./repair-scheduler.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function endpoint(id: string): StorageNodeEndpoint {
  return {
    id,
    baseUrl: `http://${id}.invalid`,
    transport: "http",
    capacity: { usedBytes: 0, availableBytes: 10_000 },
    capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, maxPieceBytes: 10_000 },
  };
}

async function setup(chunkCount = 1) {
  const dir = await mkdtemp(join(tmpdir(), "openstore-scheduler-"));
  dirs.push(dir);
  const a = endpoint("node-a");
  const b = endpoint("node-b");
  const c = endpoint("node-c");
  const chunks = Array.from({ length: chunkCount }, (_, index) => {
    const piece = Buffer.from(`piece-${index}`);
    return {
      index,
      pieceId: hashPieceId(piece),
      plaintextHash: "a".repeat(64),
      plaintextSize: 1,
      encryptedSize: piece.length,
      nodeIds: [a.id, b.id],
    };
  });
  const store = createManifestStore({ dir });
  await store.save(buildManifest({
    fileId: "scheduler-file",
    filename: "scheduler.bin",
    size: chunkCount,
    chunkSize: 1,
    cryptoVersion: 1,
    chunks,
  }));
  return { store, a, b, c };
}

function coordinator(available: StorageNodeEndpoint[], onRefresh?: () => void) {
  return {
    async refresh() {
      onRefresh?.();
      return available.map((endpoint) => ({ ...endpoint }));
    },
    getEndpoints: () => available,
    getKnownEndpoints: () => available,
  };
}

function successReport(fileId: string, chunkIndex: number, pieceId: string) {
  return {
    version: 1 as const,
    fileId,
    classification: "repaired" as const,
    chunks: [{
      chunkIndex,
      pieceId,
      removedNodeId: "node-b",
      addedNodeId: "node-c",
      sourceNodeId: "node-a",
    }],
    manifest: buildManifest({
      fileId,
      filename: "scheduler.bin",
      size: 1,
      chunkSize: 1,
      cryptoVersion: 1,
      chunks: [{
        index: chunkIndex,
        pieceId,
        plaintextHash: "a".repeat(64),
        plaintextSize: 1,
        encryptedSize: 1,
        nodeIds: ["node-a", "node-c"],
      }],
    }),
  };
}

describe("repair scheduler (049A)", () => {
  it("starts, stops, and exposes lifecycle/status events", async () => {
    const state = await setup();
    const events: RepairSchedulerEvent[] = [];
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: coordinator([state.a, state.c]),
      repair: async (fileId, options) => successReport(fileId, options.chunkIndex!, hashPieceId(Buffer.from("piece-0"))),
      options: { onEvent: (event) => events.push(event), retryBackoffMs: 0 },
    });
    expect(scheduler.status.state).toBe("stopped");
    scheduler.start();
    await scheduler.runOnce();
    scheduler.stop();
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "repair.scheduler.started", "repair.queued", "repair.observing",
      "repair.confirmed-loss", "repair.completed", "repair.scheduler.stopped",
    ]));
    expect(scheduler.status.completedCount).toBe(1);
    expect(scheduler.status.state).toBe("stopped");
  });

  it("coalesces duplicate candidates and bounds the queue", async () => {
    const state = await setup(2);
    const calls: number[] = [];
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: coordinator([state.a, state.c]),
      repair: async (fileId, options) => {
        calls.push(options.chunkIndex!);
        return successReport(fileId, options.chunkIndex!, hashPieceId(Buffer.from(`piece-${options.chunkIndex}`)));
      },
      options: { maxQueuedCandidates: 1, retryBackoffMs: 0 },
    });
    const [first, second] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    expect(first.queuedCount).toBe(0);
    expect(second.queuedCount).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("enforces global and per-file concurrency limits", async () => {
    const state = await setup(2);
    let active = 0;
    let maximum = 0;
    const release: (() => void)[] = [];
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: coordinator([state.a, state.c]),
      repair: async (fileId, options) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => release.push(resolve));
        active -= 1;
        return successReport(fileId, options.chunkIndex!, hashPieceId(Buffer.from(`piece-${options.chunkIndex}`)));
      },
      options: { globalConcurrency: 2, perFileConcurrency: 1 },
    });
    const running = scheduler.runOnce();
    await vi.waitFor(() => expect(release).toHaveLength(1));
    expect(maximum).toBe(1);
    release[0]();
    await running;
  });

  it("keeps candidates safe during coordinator outage and retries with bounded backoff", async () => {
    const state = await setup();
    let available = false;
    let calls = 0;
    const events: RepairSchedulerEvent[] = [];
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: {
        async refresh() {
          if (!available) throw new Error("coordinator unavailable");
          return [state.a, state.c];
        },
        getEndpoints: () => [state.a, state.c],
        getKnownEndpoints: () => [state.a, state.b, state.c],
      },
      repair: async (fileId, options) => {
        calls += 1;
        if (calls === 1) throw new RepairError("target-unavailable", fileId, "target failed", options.chunkIndex);
        return successReport(fileId, options.chunkIndex!, hashPieceId(Buffer.from("piece-0")));
      },
      options: { retryBackoffMs: 0, maxRetryRounds: 1, onEvent: (event) => events.push(event) },
    });
    const outage = await scheduler.runOnce();
    expect(outage.lastSchedulerErrorClassification).toBe("coordinator-unavailable");
    available = true;
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(calls).toBe(2);
    expect(events.some((event) => event.type === "repair.failed" && event.classification === "target-unavailable")).toBe(true);
    expect(scheduler.status.failedCounts["target-unavailable"]).toBe(1);
  });

  it("cancels queued work without invoking deletion or leaking secrets", async () => {
    const state = await setup();
    const events: RepairSchedulerEvent[] = [];
    const repair = vi.fn(async (fileId: string, options: { chunkIndex?: number }) =>
      successReport(fileId, options.chunkIndex!, hashPieceId(Buffer.from("piece-0"))));
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: coordinator([state.a, state.c]),
      repair,
      options: { onEvent: (event) => events.push(event) },
    });
    await scheduler.runOnce();
    scheduler.cancel();
    expect(events.some((event) => event.type === "repair.cancelled")).toBe(false);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toMatch(/password|token|privateKey|recoveryPhrase|plaintext|DEK/i);
  });

  it("discards a candidate when its node recovers before repair", async () => {
    const state = await setup();
    let available = [state.a, state.c];
    const events: RepairSchedulerEvent[] = [];
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: {
        async refresh() { return available; },
        getEndpoints: () => available,
        getKnownEndpoints: () => [state.a, state.b, state.c],
      },
      repair: vi.fn(async (fileId, options) => {
        available = [state.a, state.b, state.c];
        throw new RepairError("failed", fileId, "lost node reappeared; repair aborted", options.chunkIndex);
      }),
      options: { onEvent: (event) => events.push(event) },
    });
    await scheduler.runOnce();
    expect(events.some((event) => event.type === "repair.node-recovered")).toBe(true);
  });

  it("bounds repeated failures permanently", async () => {
    const state = await setup();
    let calls = 0;
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: coordinator([state.a, state.c]),
      repair: async (fileId, options) => {
        calls += 1;
        throw new RepairError("target-unavailable", fileId, "target unavailable", options.chunkIndex);
      },
      options: { retryBackoffMs: 0, maxRetryRounds: 1 },
    });
    for (let i = 0; i < 6; i += 1) await scheduler.runOnce();
    expect(calls).toBe(2);
    expect(scheduler.status.failedCounts["target-unavailable"]).toBe(2);
  });

  it("does not invoke repair with stale or unavailable coordinator discovery", async () => {
    const state = await setup();
    let calls = 0;
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: {
        ...coordinator([state.a, state.c]),
        discovery: {
          version: 1,
          freshness: "stale",
          source: "coordinator",
          canRepair: false,
          canPlaceNew: false,
          endpointCount: 2,
          ageMs: 100,
          canReadExisting: true,
          canDeleteExisting: true,
          requiresFreshForPlacement: true,
        },
      },
      repair: async () => { calls += 1; return successReport("scheduler-file", 0, "piece"); },
      options: { retryBackoffMs: 0, maxRetryRounds: 1 },
    },
    );
    await scheduler.runOnce();
    expect(calls).toBe(0);
    expect(scheduler.status.lastSchedulerErrorClassification).toBe("coordinator-stale");
  });

  it("keeps manifest unchanged after exhausted repair failures", async () => {
    const state = await setup();
    const before = JSON.stringify(await state.store.load("scheduler-file"));
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: coordinator([state.a, state.c]),
      repair: async (fileId, options) => {
        throw new RepairError("insufficient-capacity", fileId, "capacity unavailable", options.chunkIndex);
      },
      options: { retryBackoffMs: 0, maxRetryRounds: 1 },
    });
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(JSON.stringify(await state.store.load("scheduler-file"))).toBe(before);
    expect(scheduler.status.failedCounts["insufficient-capacity"]).toBe(2);
  });

  it("allows a bounded failed attempt to succeed on retry", async () => {
    const state = await setup();
    let calls = 0;
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: coordinator([state.a, state.c]),
      repair: async (fileId, options) => {
        calls += 1;
        if (calls === 1) throw new RepairError("target-unavailable", fileId, "temporary target failure", options.chunkIndex);
        return successReport(fileId, options.chunkIndex!, hashPieceId(Buffer.from("piece-0")));
      },
      options: { retryBackoffMs: 0, maxRetryRounds: 2 },
    });
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(calls).toBe(2);
    expect(scheduler.status.completedCount).toBe(1);
  });

  it("coalesces concurrent scheduler runs and sanitizes status", async () => {
    const state = await setup();
    let calls = 0;
    const scheduler = createRepairScheduler({
      manifestStore: state.store,
      coordinator: coordinator([state.a, state.c]),
      repair: async (fileId, options) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return successReport(fileId, options.chunkIndex!, hashPieceId(Buffer.from("piece-0")));
      },
      options: { retryBackoffMs: 0 },
    });
    await Promise.all([scheduler.runOnce(), scheduler.runOnce(), scheduler.runOnce()]);
    expect(calls).toBe(1);
    expect(JSON.stringify(scheduler.status)).not.toMatch(/plaintext|dek|private|token|password/i);
  });
});
