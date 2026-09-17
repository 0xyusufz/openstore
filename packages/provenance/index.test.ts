import { describe, expect, it } from "vitest";
import { canTransitionClaim, createOpaqueId, validatePieceClaim } from "./index.js";

const claim = () => ({
  pieceId: "piece-1",
  claimId: createOpaqueId(),
  operationId: createOpaqueId(),
  clientNamespace: "a".repeat(64),
  kind: "upload" as const,
  state: "pending" as const,
  createdAt: 1,
  updatedAt: 1,
});

describe("provenance model", () => {
  it("creates opaque IDs and validates claims", () => {
    const value = claim();
    expect(createOpaqueId()).toMatch(/^[a-f0-9]{32}$/);
    expect(() => validatePieceClaim(value)).not.toThrow();
  });

  it("enforces monotonic claim transitions", () => {
    expect(canTransitionClaim("pending", "referenced")).toBe(true);
    expect(canTransitionClaim("referenced", "pending")).toBe(false);
    expect(canTransitionClaim("released", "referenced")).toBe(false);
  });
});
