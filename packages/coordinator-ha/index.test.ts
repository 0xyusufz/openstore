import { describe, expect, it } from "vitest";
import {
  classifyCoordinatorState,
  createCoordinatorStateSnapshot,
  nextCoordinatorRevision,
} from "./index.js";
import { createIdentity } from "../identity/index.js";
import { createAuthorityProof, CoordinatorBootstrapMachine, createCoordinatorInstanceIdentity, parseCoordinatorInstanceIdentity, serializeCoordinatorInstanceIdentity, verifyAuthorityProof } from "./index.js";

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
});
