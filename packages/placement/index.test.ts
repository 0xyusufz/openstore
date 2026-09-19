import { describe, expect, it } from "vitest";
import { hasTrustedCapacity, isPlacementEligible } from "./index.js";

describe("shared placement eligibility (069 layering)", () => {
  it("excludes draining/released and validates capacity", () => {
    expect(isPlacementEligible({ lifecycle: "draining", capacity: { allocatedBytes: 100, usedBytes: 0, availableBytes: 100 } } as unknown as Parameters<typeof isPlacementEligible>[0], 10)).toBe(false);
    expect(isPlacementEligible({ lifecycle: "released", capacity: { allocatedBytes: 100, usedBytes: 0, availableBytes: 100 } } as unknown as Parameters<typeof isPlacementEligible>[0], 10)).toBe(false);
    expect(isPlacementEligible({ lifecycle: "sharing", capacity: { allocatedBytes: 100, usedBytes: 90, availableBytes: 10 } } as unknown as Parameters<typeof isPlacementEligible>[0], 10)).toBe(true);
    expect(isPlacementEligible({ lifecycle: "sharing", capacity: { allocatedBytes: 100, usedBytes: 90, availableBytes: 10 } } as unknown as Parameters<typeof isPlacementEligible>[0], 20)).toBe(false);
    expect(isPlacementEligible({ lifecycle: undefined, capacity: { allocatedBytes: 100, usedBytes: 0, availableBytes: 100 } } as unknown as Parameters<typeof isPlacementEligible>[0], 10)).toBe(true);
  });

  it("hasTrustedCapacity mirrors authoritative capacity rules", () => {
    expect(hasTrustedCapacity({ allocatedBytes: 100, usedBytes: 0, availableBytes: 100 }, 10)).toBe(true);
    expect(hasTrustedCapacity({ allocatedBytes: 100, usedBytes: 100, availableBytes: 0 }, 10)).toBe(false);
    expect(hasTrustedCapacity({ allocatedBytes: 100, usedBytes: 60, availableBytes: 50 }, 10)).toBe(false); // used+available > allocated
    expect(hasTrustedCapacity({ allocatedBytes: 0, usedBytes: 0, availableBytes: 0 }, 10)).toBe(false);
  });

  it("marketplace fail-closed for undefined lifecycle is not part of shared primitive (shared allows undefined)", () => {
    // Shared primitive allows undefined (selection's original behavior for HTTP) — marketplace adds explicit sharing check on top
    expect(isPlacementEligible({ lifecycle: undefined, capacity: { allocatedBytes: 100, usedBytes: 0, availableBytes: 100 } } as unknown as Parameters<typeof isPlacementEligible>[0], 1)).toBe(true);
  });
});
