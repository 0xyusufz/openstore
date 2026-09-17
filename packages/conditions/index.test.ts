import { describe, expect, it } from "vitest";
import { ConditionEvaluator } from "./index.js";

describe("condition evaluator", () => {
  it("evaluates deterministic threshold transitions", () => {
    const evaluator = new ConditionEvaluator();
    const clear = evaluator.evaluate({ storage: { usedBytes: 1, allocatedBytes: 100 }, coordinator: { availableNodes: 1, persistenceHealthy: true } }, 10);
    expect(clear.find((c) => c.id === "storage-capacity-low")?.active).toBe(false);
    const active = evaluator.evaluate({ storage: { usedBytes: 96, allocatedBytes: 100 }, coordinator: { availableNodes: 0, persistenceHealthy: false } }, 20);
    expect(active.find((c) => c.id === "storage-capacity-low")).toMatchObject({ active: true, severity: "critical", observed: 0.96 });
    expect(active.find((c) => c.id === "coordinator-no-available-nodes")?.active).toBe(true);
  });
  it("bounds output and returns immutable snapshots", () => {
    const evaluator = new ConditionEvaluator();
    const snapshot = evaluator.evaluate({ repair: { queued: 100 } }, 1);
    expect(snapshot.length).toBeLessThanOrEqual(16);
    expect(() => ((snapshot[0] as unknown as Record<string, unknown>).id = "secret")).toThrow();
    expect(JSON.stringify(snapshot)).not.toMatch(/password|token|private|piece|filename|path/i);
  });
  it("rejects invalid thresholds", () => {
    expect(() => new ConditionEvaluator({ capacityWarningRatio: 2 })).toThrow();
  });
});
