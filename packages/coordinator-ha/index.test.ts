import { describe, expect, it } from "vitest";
import {
  classifyCoordinatorState,
  createCoordinatorStateSnapshot,
  nextCoordinatorRevision,
} from "./index.js";
import { createIdentity } from "../identity/index.js";
import { createAuthorityProof, CoordinatorBootstrapMachine, createCoordinatorInstanceIdentity, parseCoordinatorInstanceIdentity, serializeCoordinatorInstanceIdentity, verifyAuthorityProof } from "./index.js";
import { CoordinatorReplicaImporter, createCoordinatorSnapshotExporter, createCoordinatorReplicaSyncManager } from "./index.js";
import { compareCoordinatorStateOrdering } from "./index.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../events/index.js";
import { MetricsRegistry } from "../metrics/index.js";

describe("coordinator HA foundation model", () => {
  it("creates immutable authoritative snapshots and monotonic revisions", () => {
    const snapshot = createCoordinatorStateSnapshot({
      instanceId: "coordinator-a",
      revision: 4,
      observedAt: 100,
      state: "known",
      authoritative: true,
    }, 100);
    expect(snapshot.version).toBe(1);
    expect(nextCoordinatorRevision(snapshot.revision)).toBe(5);
    expect(classifyCoordinatorState(snapshot, 110, 30_000)).toBe("fresh-authoritative");
    expect(() => ((snapshot as unknown as { revision: number }).revision = 9)).toThrow();
  });

  it("rejects invalid, future, and non-authoritative state combinations", () => {
    expect(() => createCoordinatorStateSnapshot({
      instanceId: "a", revision: -1, observedAt: 1, state: "known", authoritative: true,
    }, 1)).toThrow();
    expect(() => createCoordinatorStateSnapshot({
      instanceId: "a", revision: 1, observedAt: 40_000, state: "known", authoritative: true,
    }, 1)).toThrow();
    expect(() => createCoordinatorStateSnapshot({
      instanceId: "a", revision: 1, observedAt: 1, state: "stale", authoritative: true,
    }, 1)).toThrow();
    expect(() => nextCoordinatorRevision(Number.MAX_SAFE_INTEGER)).toThrow();
  });

  it("classifies stale, unknown, and ambiguous authority safely", () => {
    const stale = createCoordinatorStateSnapshot({
      instanceId: "a", revision: 1, observedAt: 1, state: "known", authoritative: true,
    }, 1);
    const ambiguous = createCoordinatorStateSnapshot({
      instanceId: "b", revision: 1, observedAt: 1, state: "known", authoritative: false,
    }, 1);
    expect(classifyCoordinatorState(stale, 100, 10)).toBe("stale");
    expect(classifyCoordinatorState(undefined, 100)).toBe("unknown");
    expect(classifyCoordinatorState(ambiguous, 2)).toBe("ambiguous");
  });

  it("creates and verifies authenticated bounded bootstrap proofs", () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    expect(parseCoordinatorInstanceIdentity(serializeCoordinatorInstanceIdentity(instance))).toEqual(instance);
    const now = Date.now();
    const snapshot = {
      version: 1 as const,
      instance,
      revision: 2,
      observedAt: now,
      nodes: [],
    };
    const proof = createAuthorityProof(snapshot, identity.privateKey, now);
    expect(verifyAuthorityProof(snapshot, proof, now + 10)).toBe(true);
    expect(verifyAuthorityProof({ ...snapshot, revision: 3 }, proof, now + 10)).toBe(false);
    const machine = new CoordinatorBootstrapMachine();
    expect(machine.accept(snapshot, proof, instance.instanceId, now + 10).state).toBe("authoritative");
    expect(machine.state).toBe("authoritative");
  });

  it("orders source revision and digest tuples deterministically", () => {
    const base = { instanceId: "coord-a", revision: 2, snapshotDigest: "a".repeat(64) };
    expect(compareCoordinatorStateOrdering(base, base)).toBe("duplicate");
    expect(compareCoordinatorStateOrdering(base, { ...base, revision: 1 })).toBe("stale_revision");
    expect(compareCoordinatorStateOrdering(base, { ...base, snapshotDigest: "b".repeat(64) })).toBe("revision_digest_conflict");
    expect(compareCoordinatorStateOrdering(base, { ...base, revision: 3 })).toBe("higher_revision");
    expect(compareCoordinatorStateOrdering(base, { ...base, instanceId: "coord-b" })).toBe("instance_conflict");
  });

  it("rejects tampering, stale/future proofs, wrong authority, and oversized snapshots", () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const snapshot = { version: 1 as const, instance, revision: 1, observedAt: now - 31_000, nodes: [] };
    const proof = createAuthorityProof(snapshot, identity.privateKey, now);
    expect(verifyAuthorityProof(snapshot, { ...proof, signature: proof.signature.slice(0, -2) + "aa" }, now + 10)).toBe(false);
    expect(verifyAuthorityProof(snapshot, proof, now + 100_000)).toBe(false);
    expect(() => createCoordinatorStateSnapshot({
      instanceId: "a", revision: 1, observedAt: 1, state: "known", authoritative: true,
    }, 1)).not.toThrow();
    const machine = new CoordinatorBootstrapMachine();
    expect(machine.accept(snapshot, proof, "coord-other", now + 10).accepted).toBe(false);
    expect(() => createAuthorityProof({ ...snapshot, nodes: Array.from({ length: 10_001 }, (_, i) => ({
      nodeId: `node-${i}`, publicKey: instance.publicKey, endpoint: "http://node", available: true,
      lastSeen: 100, capacity: { allocatedBytes: 1, usedBytes: 0, availableBytes: 1 }, reliability: {},
    })) }, identity.privateKey, now)).toThrow();
  });

  it("transfers state transactionally, persists it, and never grants replica authority", async () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const snapshot = { version: 1 as const, instance, revision: 1, observedAt: now, nodes: [] };
    const exporter = createCoordinatorSnapshotExporter(() => snapshot, identity.privateKey, () => now);
    const response = await exporter.request({ version: 1, maxNodes: 2, maxBytes: 4096 });
    const directory = mkdtempSync(join(tmpdir(), "openstore-053c-"));
    const persistencePath = join(directory, "replica.json");
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath });
    expect((await replica.import(response, true)).accepted).toBe(true);
    expect(replica.status().authorityClassification).toBe("non-authoritative");
    expect(replica.status().acceptedRevision).toBe(1);
    expect((await replica.import(response, true)).accepted).toBe(true);
    const reloaded = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath });
    expect(reloaded.status().state).toBe("synchronized");
    expect(reloaded.status().authorityClassification).toBe("non-authoritative");
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects conflicts, untrusted revisions, cancellation, corruption, and persistence failure", async () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const make = (revision: number, nodeId?: string) => ({
      version: 1 as const, instance, revision, observedAt: now,
      nodes: nodeId ? [{ nodeId, publicKey: instance.publicKey, endpoint: "http://node", available: true,
        lastSeen: now, capacity: { allocatedBytes: 1, usedBytes: 0, availableBytes: 1 }, reliability: {} }] : [],
    });
    const first = make(2);
    const exporter = createCoordinatorSnapshotExporter(() => first, identity.privateKey, () => now);
    const response = await exporter.request({ version: 1 });
    const directory = mkdtempSync(join(tmpdir(), "openstore-053c-"));
    const path = join(directory, "state.json");
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: path });
    await replica.import(response, true);
    const lower = make(1);
    const lowerResponse = { version: 1 as const, snapshot: lower, proof: createAuthorityProof(lower, identity.privateKey, now) };
    expect((await replica.import(lowerResponse, true)).accepted).toBe(false);
    const conflict = make(2, "node-conflict");
    const conflictResponse = { version: 1 as const, snapshot: conflict, proof: createAuthorityProof(conflict, identity.privateKey, now) };
    expect((await replica.import(conflictResponse, true)).accepted).toBe(false);
    const canceled = new AbortController();
    canceled.abort();
    expect((await replica.import(response, true, canceled.signal)).reason).toBe("unavailable");
    const corruptPath = join(directory, "corrupt.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(corruptPath, "{bad", "utf8"));
    expect(new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: corruptPath }).status().state).toBe("unavailable");
    const persistenceDirectory = join(directory, "existing");
    mkdirSync(persistenceDirectory);
    const failing = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: persistenceDirectory });
    expect((await failing.import(response, true)).accepted).toBe(false);
    expect(failing.status().authorityClassification).toBe("non-authoritative");
    rmSync(directory, { recursive: true, force: true });
  });

  it("classifies deterministic ordering outcomes and never promotes a replica", async () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const make = (revision: number, nodeId?: string) => ({
      version: 1 as const, instance, revision, observedAt: now,
      nodes: nodeId ? [{ nodeId, publicKey: instance.publicKey, endpoint: "http://node", available: true,
        lastSeen: now, capacity: { allocatedBytes: 1, usedBytes: 0, availableBytes: 1 }, reliability: {} }] : [],
    });
    const first = make(1);
    const second = make(2);
    const firstResponse = { version: 1 as const, snapshot: first, proof: createAuthorityProof(first, identity.privateKey, now) };
    const secondResponse = { version: 1 as const, snapshot: second, proof: createAuthorityProof(second, identity.privateKey, now) };
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId] });
    expect((await replica.import(firstResponse, true)).state).toBe("synchronized");
    expect((await replica.import(firstResponse, true)).reason).toBeUndefined();
    expect(replica.status().state).toBe("synchronized");
    expect((await replica.import(secondResponse, true)).accepted).toBe(true);
    const conflicting = make(2, "different");
    const conflictResult = await replica.import({ version: 1, snapshot: conflicting, proof: createAuthorityProof(conflicting, identity.privateKey, now) }, true);
    expect(conflictResult.reason).toBe("revision_digest_conflict");
    expect(replica.status().state).toBe("conflicted");
    expect(replica.status().authorityClassification).toBe("non-authoritative");
    const otherIdentity = createIdentity();
    const otherInstance = createCoordinatorInstanceIdentity(otherIdentity.publicKey);
    const otherSnapshot = { ...make(3), instance: otherInstance };
    const unknown = await replica.import({ version: 1, snapshot: otherSnapshot, proof: createAuthorityProof(otherSnapshot, otherIdentity.privateKey, now) }, true);
    expect(unknown.reason).toBe("unknown_instance");
  });

  it("rejects stale and future proofs without using timestamps for ordering", async () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const snapshot = { version: 1 as const, instance, revision: 1, observedAt: now - 31_000, nodes: [] };
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId] });
    const stale = createAuthorityProof(snapshot, identity.privateKey, now - 31_000);
    expect((await replica.import({ version: 1, snapshot, proof: stale }, true)).reason).toBe("stale_proof");
    const future = createAuthorityProof(snapshot, identity.privateKey, now + 10_000);
    expect((await replica.import({ version: 1, snapshot, proof: future }, true)).reason).toBe("future_proof");
  });

  it("coalesces concurrent syncs, retries bounded outages, and recovers", async () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const snapshot = { version: 1 as const, instance, revision: 1, observedAt: now, nodes: [] };
    const exporter = createCoordinatorSnapshotExporter(() => snapshot, identity.privateKey, () => now);
    const response = await exporter.request({ version: 1 });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const source = {
      async request(): Promise<typeof response> {
        calls += 1;
        await gate;
        return response;
      },
    };
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId] });
    const manager = createCoordinatorReplicaSyncManager(source, replica, { freshnessMs: 50 });
    const first = manager.start();
    const second = manager.syncNow();
    expect(manager.status().state).toBe("bootstrapping");
    release();
    await first;
    expect(await second).toMatchObject({ accepted: true });
    expect(calls).toBe(1);
    expect(manager.status().state).toBe("synchronized");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(manager.status().state).toBe("stale");
    manager.stop();
    expect(manager.status().state).toBe("stopped");
  });

  it("caps retry scheduling and supports explicit conflict rebootstrap", async () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const snapshot = { version: 1 as const, instance, revision: 1, observedAt: now, nodes: [] };
    const exporter = createCoordinatorSnapshotExporter(() => snapshot, identity.privateKey, () => now);
    const response = await exporter.request({ version: 1 });
    let calls = 0;
    const source = {
      async request(): Promise<typeof response> {
        calls += 1;
        throw new Error("temporary");
      },
    };
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId] });
    const timers: Array<() => void> = [];
    const manager = createCoordinatorReplicaSyncManager(source, replica, {
      maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0,
      setTimeout: (callback) => { timers.push(callback); return 1 as unknown as ReturnType<typeof globalThis.setTimeout>; },
      clearTimeout: () => undefined,
    });
    await manager.start();
    expect(manager.status().state).toBe("retry_wait");
    for (let i = 0; i < 12 && calls < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const callback = timers.shift();
      if (callback) callback();
    }
    await Promise.resolve();
    expect(calls).toBe(3);
    manager.stop();
    await manager.resetForRebootstrap();
    expect(manager.status().state).toBe("stopped");
  });

  it("exposes safe operator diagnostics, events, and bounded metrics", async () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const snapshot = { version: 1 as const, instance, revision: 1, observedAt: now, nodes: [] };
    const exporter = createCoordinatorSnapshotExporter(() => snapshot, identity.privateKey, () => now);
    const response = await exporter.request({ version: 1 });
    const events = new EventStore(20);
    const metrics = new MetricsRegistry(32);
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId] });
    const manager = createCoordinatorReplicaSyncManager(
      { request: async () => response }, replica,
      { events, metrics, freshnessMs: 100 },
    );
    await manager.start();
    const status = manager.inspectStatus();
    expect(status.state).toBe("synchronized");
    expect(status.authorityClassification).toBe("non-authoritative");
    expect(status.persistenceHealthy).toBe(true);
    await manager.forceSync();
    expect(events.recent(20).some((event) => event.type === "replica.sync.succeeded")).toBe(true);
    expect(metrics.snapshot().counters.some((metric) => metric.name === "coordinator_replica_sync_success_total")).toBe(true);
    await manager.clearConflict();
    expect(manager.status().authorityClassification).toBe("non-authoritative");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(/private|password|token|secret|snapshot contents/i);
    manager.stop();
  });
});
