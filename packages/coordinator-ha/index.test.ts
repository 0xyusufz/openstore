import { describe, expect, it } from "vitest";
import {
  classifyCoordinatorState,
  createCoordinatorStateSnapshot,
  nextCoordinatorRevision,
} from "./index.js";

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
});
