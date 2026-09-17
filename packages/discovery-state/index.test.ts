import { describe, expect, it } from "vitest";
import { DiscoveryCapabilityModel } from "./index.js";

describe("discovery capability model", () => {
  it("distinguishes fresh, cached, stale, and unavailable information", () => {
    const model = new DiscoveryCapabilityModel({ freshMaxAgeMs: 10, staleAfterMs: 30 });
    expect(model.evaluate({ source: "coordinator", endpointCount: 2, observedAt: 95, now: 100 }).freshness).toBe("fresh");
    expect(model.evaluate({ source: "cache", endpointCount: 2, observedAt: 95, now: 100 }).freshness).toBe("cached");
    expect(model.evaluate({ source: "cache", endpointCount: 2, observedAt: 60, now: 100 }).freshness).toBe("stale");
    expect(model.evaluate({ source: "coordinator", endpointCount: 0, now: 100 }).freshness).toBe("unavailable");
  });
  it("fails closed for new placement and permits existing known endpoints", () => {
    const model = new DiscoveryCapabilityModel();
    const cached = model.snapshot({ source: "cache", endpointCount: 1, observedAt: 100, now: 101 });
    expect(cached.canReadExisting).toBe(true);
    expect(cached.canPlaceNew).toBe(false);
    expect(model.allows(cached, "download")).toBe(true);
    expect(model.allows(cached, "upload")).toBe(false);
  });
  it("validates bounded timestamps and limits", () => {
    expect(() => new DiscoveryCapabilityModel({ freshMaxAgeMs: 0 })).toThrow();
    expect(() => new DiscoveryCapabilityModel({ freshMaxAgeMs: 10, staleAfterMs: 5 })).toThrow();
    expect(() => new DiscoveryCapabilityModel().evaluate({ source: "cache", endpointCount: -1 })).toThrow();
  });
  it("distinguishes stale information from unavailable usable discovery", () => {
    const model = new DiscoveryCapabilityModel({ freshMaxAgeMs: 10, staleAfterMs: 30 });
    expect(model.evaluate({ source: "coordinator", endpointCount: 1, observedAt: 60, now: 100 }).freshness).toBe("stale");
    expect(model.evaluate({ source: "coordinator", endpointCount: 1, observedAt: 60, now: 100, usable: false }).freshness).toBe("unavailable");
  });
});
