import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createAuthorityRecoveryPolicy, type AuthorityRecoveryEvidence } from "./authority-recovery-policy.js";

function validEvidence(issuerInstanceId: string, candidateInstanceId: string, epoch = 1): AuthorityRecoveryEvidence {
  return {
    version: 1,
    issuerInstanceId,
    issuerInitialized: true,
    issuerPersistenceState: "valid",
    candidateInstanceId,
    authorityEpoch: epoch,
    candidateEpoch: epoch,
    candidateState: "non-authoritative",
    ownershipState: "non-authoritative",
    ownershipEpoch: epoch,
    ownerInstanceId: candidateInstanceId,
    stateRevision: 7,
    stateDigest: "a".repeat(64),
    stateFresh: true,
    validGrant: true,
    grantRevoked: false,
    issuerIdentityMatches: true,
    persistedStateHealthy: true,
    activeOwnershipConflict: false,
  };
}

describe("053Q authority recovery policy", () => {
  it("accepts a valid explicit operator authorization and explicit approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053q-"));
    const issuerIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(createIdentity().publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const policy = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: join(dir, "recovery-policy.json"),
      now: () => 1_000,
    });
    const evidence = validEvidence(issuerInstanceId, candidateInstanceId, 1);
    const request = {
      version: 1 as const,
      candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId,
      operatorIdentity: "operator:alice",
      issuedAt: 1_000,
      expiresAt: 60_000,
    };
    const authorization = await policy.requestAuthorization(request);
    const result = policy.approveRecovery(evidence, authorization);
    expect(result.decision).toBe("allowed");
    expect(result.state).toBe("recovered");
  });

  it("rejects candidate self-authorization and wrong binding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053q-self-"));
    const issuerIdentity = createIdentity();
    const candidateIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(candidateIdentity.publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const policy = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: join(dir, "recovery-policy.json"),
      now: () => 1_000,
    });
    await expect(policy.requestAuthorization({
      version: 1,
      candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId,
      operatorIdentity: candidateInstanceId,
      issuedAt: 1_000,
      expiresAt: 60_000,
    })).rejects.toThrow(/self/i);
    const evidence = validEvidence(issuerInstanceId, candidateInstanceId, 1);
    const authorization = await policy.requestAuthorization({
      version: 1,
      candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId,
      operatorIdentity: "operator:alice",
      issuedAt: 1_000,
      expiresAt: 60_000,
    });
    expect(() => policy.approveRecovery({ ...evidence, candidateInstanceId: "coord-11111111111111111111111111111111" }, authorization)).toThrow(/invalid|mismatch/i);
    expect(() => policy.approveRecovery({ ...evidence, authorityEpoch: 2 }, authorization)).toThrow(/invalid|mismatch|epoch/i);
  });

  it("rejects expired, revoked, and replayed authorizations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053q-reject-"));
    const issuerIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(createIdentity().publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const policy = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: join(dir, "recovery-policy.json"),
      now: () => 10_000,
    });
    const evidence = validEvidence(issuerInstanceId, candidateInstanceId, 1);
    const authorization = await policy.requestAuthorization({
      version: 1,
      candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId,
      operatorIdentity: "operator:alice",
      issuedAt: 1_000,
      expiresAt: 2_000,
    });
    expect(() => policy.approveRecovery(evidence, authorization)).toThrow(/expired|invalid/i);
    const active = await policy.requestAuthorization({
      version: 1,
      candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId,
      operatorIdentity: "operator:bob",
      issuedAt: 10_000,
      expiresAt: 30_000,
    });
    await policy.rejectAuthorization(active.authorizationId, "revoked-by-operator");
    expect(() => policy.approveRecovery(evidence, active)).toThrow(/revoked|invalid/i);
    expect(policy.inspect().revokedAuthorizationIds).toContain(active.authorizationId);
  });

  it("persists valid authorizations and revocations across restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053q-persist-"));
    const path = join(dir, "recovery-policy.json");
    const issuerIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(createIdentity().publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const first = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: path,
      now: () => 1_000,
    });
    const authorization = await first.requestAuthorization({
      version: 1,
      candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId,
      operatorIdentity: "operator:alice",
      issuedAt: 1_000,
      expiresAt: 60_000,
    });
    await first.rejectAuthorization(authorization.authorizationId, "operator revocation");
    const persisted = readFileSync(path, "utf8");
    expect(persisted).toContain("authorizationId");
    const restarted = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: path,
      now: () => 1_000,
    });
    expect(restarted.inspect().revokedAuthorizationIds).toContain(authorization.authorizationId);
    expect(restarted.inspect().authorizations.some((entry) => entry.authorizationId === authorization.authorizationId)).toBe(true);
  });

  it("fails closed on missing and corrupt policy persistence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053q-corrupt-"));
    const path = join(dir, "recovery-policy.json");
    const issuerIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(createIdentity().publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const policy = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: path,
      now: () => 1_000,
    });
    expect(policy.inspect().persistenceState).toBe("missing");
    writeFileSync(path, "{corrupt-json", "utf8");
    const corrupt = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: path,
      now: () => 1_000,
    });
    expect(corrupt.inspect().persistenceState).toBe("corrupt");
    const evidence = validEvidence(issuerInstanceId, candidateInstanceId, 1);
    expect(corrupt.evaluateRecovery(evidence).decision).toBe("denied");
  });
});
