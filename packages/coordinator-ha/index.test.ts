import { describe, expect, it } from "vitest";
import {
  classifyCoordinatorState,
  createCoordinatorStateSnapshot,
  nextCoordinatorRevision,
} from "./index.js";
import { createIdentity } from "../identity/index.js";
import { createAuthorityProof, CoordinatorBootstrapMachine, createCoordinatorInstanceIdentity, parseCoordinatorInstanceIdentity, serializeCoordinatorInstanceIdentity, verifyAuthorityProof } from "./index.js";
import { CoordinatorReplicaImporter, createCoordinatorSnapshotExporter } from "./index.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("rejects tampering, stale/future proofs, wrong authority, and oversized snapshots", () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const snapshot = { version: 1 as const, instance, revision: 1, observedAt: now, nodes: [] };
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
    expect(reloaded.status().state).toBe("accepted");
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
});
