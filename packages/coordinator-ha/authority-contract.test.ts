import { describe, expect, it } from "vitest";
import { evaluateAuthorityState, validateAuthorityGrant, validatePromotionEvidence } from "./authority-contract.js";

const id = "coord-0123456789abcdef0123456789abcdef";
const digest = "a".repeat(64);

describe("future coordinator authority contract", () => {
  it("keeps replicas and ambiguous states non-authoritative", () => {
    for (const state of ["replica", "stale", "conflicted", "unavailable", "rejected", "unknown"] as const) {
      const result = evaluateAuthorityState(state);
      expect(result.placementAuthorized).toBe(false);
      expect(result.eligible).toBe(false);
      expect(result.snapshotImportAllowed).toBe(true);
    }
  });

  it("requires explicit, fresh, trusted, anti-replay evidence", () => {
    const base = {
      version: 1 as const, instanceId: id, stateRevision: 4, stateDigest: digest,
      proofVerified: true, sourceTrusted: true, fresh: true,
      explicitlyAuthorized: true, antiReplayValid: true, splitBrainFree: true,
    };
    expect(validatePromotionEvidence(base, id).placementAuthorized).toBe(true);
    expect(validatePromotionEvidence({ ...base, explicitlyAuthorized: false }, id).reason).toBe("not-explicitly-authorized");
    expect(validatePromotionEvidence({ ...base, splitBrainFree: false }, id).reason).toBe("authority-ambiguous");
    expect(validatePromotionEvidence({ ...base, stateRevision: 99 }, "coord-ffffffffffffffffffffffffffffffff").reason).toBe("identity-mismatch");
  });

  it("rejects malformed authority grants", () => {
    expect(validateAuthorityGrant(undefined)).toBe(false);
    expect(validateAuthorityGrant({
      version: 1, candidateInstanceId: id, authorityEpoch: 1, stateRevision: 4,
      stateDigest: digest, grantId: "grant-1", issuedAt: Date.now(),
    })).toBe(true);
    expect(validateAuthorityGrant({
      version: 1, candidateInstanceId: id, authorityEpoch: 1, stateRevision: 4,
      stateDigest: "bad", grantId: "grant-1", issuedAt: Date.now(),
    })).toBe(false);
  });
});
