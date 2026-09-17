import { describe, expect, it } from "vitest";
import { EventStore, validateOperationalEvent } from "./index.js";

const event = (n: number) => ({
  version: 1 as const, timestamp: n, component: "client" as const,
  type: "client.download-failed" as const, severity: "error" as const,
  details: { reason: "transient" },
});

describe("operational events", () => {
  it("validates allowlisted events and rejects sensitive details", () => {
    expect(() => validateOperationalEvent({ ...event(1), details: { reason: "password" } })).toThrow();
    expect(() => validateOperationalEvent({ ...event(1), details: { filename: "secret" } as never })).toThrow();
    expect(validateOperationalEvent(event(1)).version).toBe(1);
  });
  it("evicts oldest entries and returns isolated snapshots", () => {
    const store = new EventStore(2);
    store.append(event(1)); store.append(event(2)); store.append(event(3));
    const snapshot = store.snapshot();
    expect(snapshot.map((item) => item.timestamp)).toEqual([2, 3]);
    expect(() => ((snapshot[0]!.details as Record<string, unknown>).reason = "changed")).toThrow();
    expect(store.snapshot()[0]!.details.reason).toBe("transient");
  });
  it("supports bounded recent queries and safe identifiers", () => {
    const store = new EventStore(3);
    store.append({ ...event(1), correlationId: "corr-1", operationId: "op-1" });
    expect(store.recent(1)[0]!.correlationId).toBe("corr-1");
    expect(() => store.recent(0)).toThrow();
    expect(() => store.append({ ...event(2), operationId: "file-123" })).toThrow();
  });
});
