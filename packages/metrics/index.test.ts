import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "./index.js";

describe("metrics foundation", () => {
  it("records deterministic counters, gauges, and observations", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("requests_total", 2, { operation: "get" });
    metrics.set("capacity_bytes", 10);
    metrics.observe("request_duration_ms", 4, { operation: "get" });
    expect(metrics.snapshot()).toMatchObject({
      counters: [{ name: "requests_total", value: 2 }],
      gauges: [{ name: "capacity_bytes", value: 10 }],
      histograms: [{ name: "request_duration_ms", value: 4 }],
    });
  });
  it("rejects invalid names and labels and bounds arbitrary series", () => {
    const metrics = new MetricsRegistry(2);
    expect(() => metrics.increment("BadName")).toThrow();
    expect(() => metrics.increment("ok_total", 1, { operation: "piece/id" })).toThrow();
    metrics.increment("one_total", 1);
    metrics.increment("two_total", 1);
    expect(() => metrics.increment("three_total", 1)).toThrow(/series limit/);
  });
  it("never exposes sensitive labels", () => {
    const metrics = new MetricsRegistry();
    expect(() => metrics.increment("requests_total", 1, { operation: "password" })).toThrow();
    expect(JSON.stringify(metrics.snapshot())).not.toMatch(/private|secret|token|plaintext|dek/i);
  });
});
