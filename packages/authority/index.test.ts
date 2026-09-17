import { describe, expect, it } from "vitest";
import { classifyAuthority, reconcileAuthority } from "./index.js";

describe("authority boundary", () => {
  it("keeps fresh coordinator information authoritative", () => {
    const result = reconcileAuthority(
      { source: "coordinator", freshness: "fresh", coordinatorAuthoritative: true, endpointCount: 2 },
      { source: "dht", freshness: "fresh", endpointCount: 2 },
    );
    expect(result.winner).toBe("coordinator");
    expect(result.coordinator.placementAuthorized).toBe(true);
    expect(result.dht.placementAuthorized).toBe(false);
  });

  it("cannot promote stale or invalid DHT observations", () => {
    for (const freshness of ["stale", "invalid"] as const) {
      const result = reconcileAuthority(
        { source: "coordinator", freshness: "fresh", coordinatorAuthoritative: true, endpointCount: 1 },
        { source: "dht", freshness, endpointCount: 1 },
      );
      expect(result.winner).toBe("coordinator");
      expect(result.dht.placementAuthorized).toBe(false);
    }
  });

  it("does not interpret disappearance as revocation", () => {
    const result = reconcileAuthority(
      { source: "coordinator", freshness: "unavailable", endpointCount: 0 },
      { source: "dht", freshness: "unavailable", endpointCount: 0 },
    );
    expect(result.winner).toBe("none");
    expect(result.disappearanceImpliesRevocation).toBe(false);
    expect(result.coordinator.revocation).toBe("not-established");
  });

  it("returns immutable bounded decisions", () => {
    const decision = classifyAuthority({ source: "dht", freshness: "fresh", endpointCount: 1 });
    expect(() => ((decision as unknown as { classification: string }).classification = "coordinator-authoritative")).toThrow();
    expect(JSON.stringify(decision)).not.toMatch(/https?:|node|piece|path|secret/i);
  });
});
