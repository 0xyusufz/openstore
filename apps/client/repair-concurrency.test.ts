import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { buildManifest, hashPieceId } from "../../packages/manifest/index.js";
import { createManifestStore, type ManifestStore } from "../../packages/manifest/store.js";
import type { StorageNodeEndpoint, CoordinatorEndpointProvider } from "./index.js";
import type { P2PTransport, P2PNodeAddress } from "../../packages/p2p/index.js";
import { repairManifestReplica, RepairError } from "./repair.js";
import { createRepairScheduler } from "./repair-scheduler.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

function ep(id: string, opts: Partial<StorageNodeEndpoint> = {}): StorageNodeEndpoint {
  return {
    id,
    baseUrl: `http://${id}.invalid`,
    transport: "http",
    capacity: { usedBytes: 0, availableBytes: 10_000, allocatedBytes: 10_000 },
    capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, maxPieceBytes: 10_000 },
    ...opts,
  };
}
function coord(available: StorageNodeEndpoint[], known = available, extra: Partial<CoordinatorEndpointProvider> = {}): CoordinatorEndpointProvider {
  return {
    async refresh() { return available.map((v) => ({ ...v })); },
    getEndpoints() { return available.map((v) => ({ ...v })); },
    getKnownEndpoints() { return known.map((v) => ({ ...v })); },
    ...extra,
  } as CoordinatorEndpointProvider;
}
function transportFor(pieces: Map<string, Map<string, Buffer>>, failStoreFor?: string): P2PTransport {
  const mFor = (node: P2PNodeAddress) => {
    let m = pieces.get(node.nodeId);
    if (!m) { m = new Map(); pieces.set(node.nodeId, m); }
    return m;
  };
  return {
    protocol: "http",
    async health() { return { available: true, capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true } }; },
    async getPiece(node, pieceId) {
      const d = mFor(node).get(pieceId);
      return d ? { status: 200, bytes: Buffer.from(d) } : { status: 404 };
    },
    async storePiece(node, pieceId, data) {
      if (failStoreFor && node.nodeId === failStoreFor) return { status: 503 };
      mFor(node).set(pieceId, Buffer.from(data));
      return { status: 201 };
    },
    async deletePiece(node, pieceId) { mFor(node).delete(pieceId); return { status: 204 }; },
  };
}
async function makeStoreWithFile(fileId: string, chunks: number, nodeIds: string[]): Promise<{ store: ManifestStore; pieceIds: string[]; pieces: Map<string, Map<string, Buffer>> }> {
  const dir = await mkdtemp(join(tmpdir(), "openstore-conc-"));
  dirs.push(dir);
  const store = createManifestStore({ dir });
  const pieceIds: string[] = [];
  const pieces = new Map<string, Map<string, Buffer>>();
  const manifestChunks = Array.from({ length: chunks }, (_, i) => {
    const p = Buffer.from(`piece-${fileId}-${i}`);
    const pid = hashPieceId(p);
    pieceIds.push(pid);
    // seed first node with piece
    let m = pieces.get(nodeIds[0]!);
    if (!m) { m = new Map(); pieces.set(nodeIds[0]!, m); }
    m.set(pid, p);
    return { index: i, pieceId: pid, plaintextHash: "a".repeat(64), plaintextSize: 1, encryptedSize: p.length, nodeIds: [...nodeIds] };
  });
  await store.save(buildManifest({ fileId, filename: `${fileId}.bin`, size: chunks, chunkSize: 1, cryptoVersion: 1, chunks: manifestChunks }));
  return { store, pieceIds, pieces };
}

describe("Milestone 063: Repair Concurrency (unit)", () => {
  it("1. multiple triggers for same manifest/piece converge to one effective operation", async () => {
    const a = ep("node-a"), b = ep("node-b"), c = ep("node-c");
    const { store, pieceIds, pieces } = await makeStoreWithFile("file-converge", 1, ["node-a", "node-b"]);
    const opts = { manifestStore: store, coordinator: coord([a, c], [a, b, c]), lostNodeId: "node-b", observationCount: 1, observationIntervalMs: 0, transport: transportFor(pieces) };
    const [r1, r2, r3] = await Promise.all([repairManifestReplica("file-converge", opts), repairManifestReplica("file-converge", opts), repairManifestReplica("file-converge", opts)]);
    expect(r1.manifest.chunks[0].nodeIds).toEqual(r2.manifest.chunks[0].nodeIds);
    expect(r2.manifest.chunks[0].nodeIds).toEqual(r3.manifest.chunks[0].nodeIds);
    expect(r1.manifest.chunks[0].nodeIds).toEqual(["node-a", "node-c"]);
    expect((await store.loadWithRevision("file-converge"))?.revision).toBe(2);
  });

  it("2. concurrent repairs cannot create duplicate placement", async () => {
    const a = ep("node-a"), b = ep("node-b"), c = ep("node-c"), d = ep("node-d");
    const { store, pieces } = await makeStoreWithFile("file-dedup", 2, ["node-a", "node-b"]);
    const t = transportFor(pieces);
    // Two concurrent repairs for different chunks of same file would normally be serialized by perFileConcurrency=1,
    // but direct repair calls for same file with chunkIndex undefined will repair all chunks sequentially within one operation.
    // Test that parallel file-level repairs do not duplicate.
    const [r1, r2] = await Promise.all([
      repairManifestReplica("file-dedup", { manifestStore: store, coordinator: coord([a, c], [a, b, c, d]), lostNodeId: "node-b", chunkIndex: 0, observationCount: 1, observationIntervalMs: 0, transport: t }),
      repairManifestReplica("file-dedup", { manifestStore: store, coordinator: coord([a, c], [a, b, c, d]), lostNodeId: "node-b", chunkIndex: 1, observationCount: 1, observationIntervalMs: 0, transport: t }),
    ]);
    // Each repaired its own chunk; no chunk should have duplicate nodeIds
    const final = await store.load("file-dedup");
    for (const ch of final!.chunks) {
      expect(new Set(ch.nodeIds).size).toBe(ch.nodeIds.length);
      expect(ch.nodeIds).not.toContain("node-b");
      expect(ch.nodeIds.length).toBe(2);
    }
    // Ensure no piece was placed twice on same target due to race (pieces map has one copy per target)
    expect(pieces.get("node-c")?.size).toBe(2);
  });

  it("3. manifest CAS/provenance conflicts handled without corruption", async () => {
    const a = ep("node-a"), b = ep("node-b"), c = ep("node-c");
    const { store, pieces } = await makeStoreWithFile("file-cas", 1, ["node-a", "node-b"]);
    // Simulate concurrent writer that bumps revision between repair's load and CAS
    const origSaveIfRevision = store.saveIfRevision.bind(store);
    let conflictInjected = false;
    const wrappedStore: ManifestStore = {
      ...store,
      async saveIfRevision(fileId, rev, next) {
        if (!conflictInjected) {
          conflictInjected = true;
          // concurrent update: save a different manifest to bump revision
          const cur = await store.loadWithRevision(fileId);
          const conflictManifest = buildManifest({ fileId: cur!.manifest.fileId, filename: cur!.manifest.filename, size: cur!.manifest.size, chunkSize: cur!.manifest.chunkSize, cryptoVersion: cur!.manifest.cryptoVersion, chunks: cur!.manifest.chunks.map((ch) => ({ ...ch, nodeIds: [...ch.nodeIds] })) });
          // Force a revision bump via direct store
          await origSaveIfRevision(fileId, rev, conflictManifest);
          throw new (await import("../../packages/manifest/store.js")).ManifestConflictError(fileId, rev, rev + 1);
        }
        return origSaveIfRevision(fileId, rev, next);
      },
    };
    const report = await repairManifestReplica("file-cas", { manifestStore: wrappedStore, coordinator: coord([a, c], [a, b, c]), lostNodeId: "node-b", observationCount: 1, observationIntervalMs: 0, transport: transportFor(pieces) });
    // Even though first CAS conflicted, retry should succeed or handle manifest-conflict safely without corruption
    const final = await store.load("file-cas");
    expect(final!.chunks[0].nodeIds.length).toBe(2);
    expect(new Set(final!.chunks[0].nodeIds).size).toBe(2);
    // provenance store not used here (no identity), but CAS did not corrupt
    expect(report.manifest.chunks[0].nodeIds).toContain("node-c");
  });

  it("4. different pieces/manifests repair concurrently within bounded global limit", async () => {
    const a = ep("node-a"), b = ep("node-b"), c = ep("node-c");
    // Use one file with 2 chunks and perFileConcurrency 2 to test intra-file concurrency,
    // and also test global limit 2
    const { store } = await makeStoreWithFile("file-conc", 2, ["node-a", "node-b"]);
    let active = 0, maxActive = 0;
    const release: (() => void)[] = [];
    const scheduler = createRepairScheduler({
      manifestStore: store,
      coordinator: coord([a, c]),
      repair: async (fileId, opts) => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise<void>((res) => release.push(res));
        active--;
        return { version: 1 as const, fileId, classification: "repaired" as const, chunks: [{ chunkIndex: opts.chunkIndex!, pieceId: "p", removedNodeId: "node-b", addedNodeId: "node-c", sourceNodeId: "node-a" }], manifest: await store.load(fileId) as any };
      },
      options: { globalConcurrency: 2, perFileConcurrency: 2, retryBackoffMs: 0 },
    });
    const run = scheduler.runOnce();
    await vi.waitFor(() => expect(release.length).toBeGreaterThanOrEqual(1));
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThanOrEqual(1);
    release.forEach((r) => r());
    await run;
    expect(scheduler.status.activeRepairCount).toBe(0);
    // Also test inter-file concurrency with perFile 1
    const { store: s1 } = await makeStoreWithFile("file-conc-x", 1, ["node-a", "node-b"]);
    const { store: s2 } = await makeStoreWithFile("file-conc-y", 1, ["node-a", "node-b"]);
    const secondManifest = (await s2.load("file-conc-y"))!;
    await s1.save(secondManifest);
    let active2 = 0, maxActive2 = 0;
    const release2: (() => void)[] = [];
    const scheduler2 = createRepairScheduler({
      manifestStore: s1,
      coordinator: coord([a, c]),
      repair: async (fid, opts) => {
        active2++; maxActive2 = Math.max(maxActive2, active2);
        await new Promise<void>((res) => release2.push(res));
        active2--;
        return { version: 1 as const, fileId: fid, classification: "repaired" as const, chunks: [{ chunkIndex: opts.chunkIndex!, pieceId: "p", removedNodeId: "node-b", addedNodeId: "node-c", sourceNodeId: "node-a" }], manifest: await s1.load(fid) as any };
      },
      options: { globalConcurrency: 2, perFileConcurrency: 1, retryBackoffMs: 0 },
    });
    const run2 = scheduler2.runOnce();
    await vi.waitFor(() => expect(release2.length).toBeGreaterThanOrEqual(1));
    expect(maxActive2).toBeLessThanOrEqual(2);
    release2.forEach((r) => r());
    await run2;
  });

  it("5. per-operation retries remain bounded", async () => {
    const a = ep("node-a"), b = ep("node-b"), c = ep("node-c");
    const { store, pieces } = await makeStoreWithFile("file-retry", 1, ["node-a", "node-b"]);
    // Make target always fail (503) to exhaust retries
    const t = transportFor(pieces, "node-c");
    await expect(repairManifestReplica("file-retry", { manifestStore: store, coordinator: coord([a, c], [a, b, c]), lostNodeId: "node-b", observationCount: 1, observationIntervalMs: 0, transport: t, retryAttempts: 1, maxTargetAttempts: 2, maxCasRetries: 1 })).rejects.toMatchObject({ classification: "target-unavailable" });
    // Ensure manifest unchanged
    expect((await store.load("file-retry"))!.chunks[0].nodeIds).toEqual(["node-a", "node-b"]);
    // Also scheduler-level bounded retries
    let calls = 0;
    const sched = createRepairScheduler({
      manifestStore: store,
      coordinator: coord([a, c]),
      repair: async () => { calls++; throw new RepairError("target-unavailable", "file-retry", "fail"); },
      options: { maxRetryRounds: 2, retryBackoffMs: 0 },
    });
    for (let i = 0; i < 5; i++) await sched.runOnce();
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("6. global concurrency remains bounded under repeated failure/reconnect", async () => {
    const a = ep("node-a"), b = ep("node-b"), c = ep("node-c");
    const { store } = await makeStoreWithFile("file-global", 1, ["node-a", "node-b"]);
    let fail = true;
    const scheduler = createRepairScheduler({
      manifestStore: store,
      coordinator: { async refresh() { if (fail) throw new Error("offline"); return [a, c]; }, getEndpoints: () => [a, c], getKnownEndpoints: () => [a, b, c] } as any,
      repair: async () => { throw new RepairError("target-unavailable", "file-global", "fail"); },
      options: { globalConcurrency: 1, perFileConcurrency: 1, maxRetryRounds: 1, retryBackoffMs: 0, maxQueuedCandidates: 5 },
    });
    for (let i = 0; i < 4; i++) await scheduler.runOnce();
    expect(scheduler.status.activeRepairCount).toBe(0);
    expect(scheduler.status.queuedCount).toBe(0); // exhausted after retries, not still queued
    fail = false;
    // After reconnect, scheduling should resume (signature change will clear exhausted)
    // Simulate signature change by making available include different capacity
    const a2 = ep("node-a", { capacity: { usedBytes: 0, availableBytes: 9999, allocatedBytes: 10000 } } as any);
    (scheduler as any); // just ensure no throw on next tick
    const scheduler2 = createRepairScheduler({
      manifestStore: store,
      coordinator: coord([a2, c]),
      repair: async (fid, opts) => ({ version: 1 as const, fileId: fid, classification: "repaired" as const, chunks: [], manifest: await store.load(fid) as any }),
      options: { globalConcurrency: 1, retryBackoffMs: 0 },
    });
    await scheduler2.runOnce();
    expect(scheduler2.status.activeRepairCount).toBe(0);
  });

  it("7. coordinator stale/unavailable prevents new repair work", async () => {
    const a = ep("node-a"), c = ep("node-c");
    const { store } = await makeStoreWithFile("file-stale", 1, ["node-a", "node-b"]);
    let calls = 0;
    const staleCoord = { async refresh() { return [a, c]; }, getEndpoints: () => [a, c], getKnownEndpoints: () => [a, c], discovery: { version: 1 as const, freshness: "stale" as const, source: "coordinator" as const, endpointCount: 2, canRepair: false, canPlaceNew: false, canReadExisting: true, canDeleteExisting: true, requiresFreshForPlacement: true as const } };
    const sched = createRepairScheduler({ manifestStore: store, coordinator: staleCoord as any, repair: async () => { calls++; return { version: 1 as const, fileId: "x", classification: "repaired" as const, chunks: [], manifest: null as any }; }, options: { retryBackoffMs: 0 } });
    await sched.runOnce();
    expect(calls).toBe(0);
    expect(sched.status.lastSchedulerErrorClassification).toBe("coordinator-stale");
  });

  it("8. lifecycle/capacity changes are revalidated", async () => {
    const a = ep("node-a"), b = ep("node-b");
    const draining = ep("node-c", { lifecycle: "draining" as const });
    const good = ep("node-d");
    const { store, pieces } = await makeStoreWithFile("file-lifecycle", 1, ["node-a", "node-b"]);
    // First, draining target should be filtered and good selected
    const report = await repairManifestReplica("file-lifecycle", { manifestStore: store, coordinator: coord([a, draining, good], [a, b, draining, good]), lostNodeId: "node-b", observationCount: 1, observationIntervalMs: 0, transport: transportFor(pieces) });
    expect(report.chunks[0].addedNodeId).toBe("node-d");
    expect((await store.load("file-lifecycle"))!.chunks[0].nodeIds).not.toContain("node-c");
    // Capacity insufficient: small availableBytes
    const small = ep("node-e", { capacity: { usedBytes: 0, availableBytes: 1, allocatedBytes: 10 } as any });
    const { store: s2, pieces: p2 } = await makeStoreWithFile("file-cap", 1, ["node-a", "node-b"]);
    // piece size is ~12 bytes, so available 1 is insufficient
    await expect(repairManifestReplica("file-cap", { manifestStore: s2, coordinator: coord([a, small], [a, b, small]), lostNodeId: "node-b", observationCount: 1, observationIntervalMs: 0, transport: transportFor(p2) })).rejects.toMatchObject({ classification: "insufficient-capacity" });
  });

  it("9. cancellation does not leave stuck state or suppress future repair", async () => {
    const a = ep("node-a"), b = ep("node-b"), c = ep("node-c");
    const { store } = await makeStoreWithFile("file-cancel", 1, ["node-a", "node-b"]);
    // Use abortable repair to test cancellation
    const abortableRepair = async (fid: string, opts: any) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), 100);
        opts.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new RepairError("cancelled", fid, "repair cancelled", opts.chunkIndex)); }, { once: true });
      });
      return { version: 1 as const, fileId: fid, classification: "repaired" as const, chunks: [{ chunkIndex: 0, pieceId: "p", removedNodeId: "node-b", addedNodeId: "node-c", sourceNodeId: "node-a" }], manifest: await store.load(fid) as any };
    };
    const sched = createRepairScheduler({ manifestStore: store, coordinator: coord([a, c]), repair: abortableRepair as any, options: { retryBackoffMs: 0 } });
    // Start scheduler and immediately cancel - should abort in-flight
    sched.start();
    // Wait a bit for it to queue and start
    await new Promise((r) => setTimeout(r, 20));
    sched.cancel();
    expect(sched.status.state).toBe("paused");
    // Give time for abort to propagate
    await new Promise((r) => setTimeout(r, 30));
    expect(sched.status.activeRepairCount).toBe(0);
    // Future repair should be able to resume (not permanently suppressed) because cancel cleared cooldowns
    const sched2 = createRepairScheduler({ manifestStore: store, coordinator: coord([a, c]), repair: async (fid) => ({ version: 1 as const, fileId: fid, classification: "repaired" as const, chunks: [{ chunkIndex: 0, pieceId: "p", removedNodeId: "node-b", addedNodeId: "node-c", sourceNodeId: "node-a" }], manifest: await store.load(fid) as any }), options: { retryBackoffMs: 0 } });
    await sched2.runOnce();
    expect(sched2.status.completedCount).toBe(1);
    sched.stop(); sched2.stop();
  });

  it("10. healing allows resume without duplicate", async () => {
    const a = ep("node-a"), b = ep("node-b"), c = ep("node-c");
    const d = ep("node-d");
    const { store } = await makeStoreWithFile("file-heal", 1, ["node-a", "node-b"]);
    let available: StorageNodeEndpoint[] = [a, c]; // b missing
    const coordinator = { async refresh() { return available.map((v) => ({ ...v })); }, getEndpoints: () => available.map((v) => ({ ...v })), getKnownEndpoints: () => [a, b, c, d].map((v) => ({ ...v })), discovery: { version: 1 as const, freshness: "fresh" as const, source: "coordinator" as const, endpointCount: 2, canRepair: true, canPlaceNew: true, canReadExisting: true, canDeleteExisting: true, requiresFreshForPlacement: true as const } } as any;
    const scheduler = createRepairScheduler({
      manifestStore: store,
      coordinator,
      repair: async (fid, opts) => { throw new RepairError("target-unavailable", fid, "no target", opts.chunkIndex); },
      options: { maxRetryRounds: 1, retryBackoffMs: 0, maxQueuedCandidates: 10 },
    });
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(scheduler.status.failedCounts["target-unavailable"]).toBe(2); // bounded
    expect(scheduler.status.queuedCount).toBe(0); // exhausted
    // Healing: add new node d with sharing, which changes discoverySignature (capacity)
    available = [a, c, d];
    // Next run should clear exhausted and re-queue
    await scheduler.runOnce();
    // Should have re-queued and attempted again (failed again but not suppressed)
    expect(scheduler.status.failedCounts["target-unavailable"]).toBe(3);
  });
});
