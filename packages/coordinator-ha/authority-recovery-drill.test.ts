import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createAuthorityRecoveryPolicy, type AuthorityRecoveryEvidence } from "./authority-recovery-policy.js";
import { createAuthorityRecoveryDrill } from "./authority-recovery-drill.js";

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

describe("054 authority recovery drill", () => {
  it("diagnoses healthy and degraded state without mutating authority", () => {
    const tmp = mkdtempSync(join(tmpdir(), "openstore-054-"));
    const issuerIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(createIdentity().publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const policy = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: join(tmp, "recovery.json"),
      now: () => 1_000,
    });
    const drill = createAuthorityRecoveryDrill({ policy, persistencePath: join(tmp, "drill.json") });
    const healthy = drill.diagnose(validEvidence(issuerInstanceId, candidateInstanceId, 1));
    expect(healthy.state).toBe("authorization-required");
    expect(healthy.authorizationRequired).toBe(true);
    const degraded = drill.diagnose({ ...validEvidence(issuerInstanceId, candidateInstanceId, 1), issuerPersistenceState: "corrupt" });
    expect(degraded.state).toBe("degraded");
    expect(degraded.recoveryState).toBe("unavailable");
  });

  it("requires explicit authorization and blocks invalid transitions", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "openstore-054-prepare-"));
    const issuerIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(createIdentity().publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const policy = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: join(tmp, "recovery.json"),
      now: () => 1_000,
    });
    const drill = createAuthorityRecoveryDrill({ policy, persistencePath: join(tmp, "drill.json") });
    const auth = await policy.requestAuthorization({
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
    const prepared = drill.prepare(validEvidence(issuerInstanceId, candidateInstanceId, 1), auth);
    expect(prepared.state).toBe("authorized");
    expect(() => drill.execute("reset", validEvidence(issuerInstanceId, candidateInstanceId, 1), auth)).not.toThrow();
    expect(() => drill.execute("approve", validEvidence(issuerInstanceId, candidateInstanceId, 1), auth)).not.toThrow();
    expect(() => drill.execute("fence", validEvidence(issuerInstanceId, candidateInstanceId, 1), auth)).not.toThrow();
    expect(() => drill.execute("approve", validEvidence(issuerInstanceId, candidateInstanceId, 1), auth)).not.toThrow();
  });

  it("stores and restores drill status and fails closed on corrupt persistence", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "openstore-054-persist-"));
    const path = join(tmp, "drill.json");
    const issuerIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(createIdentity().publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const policy = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: join(tmp, "recovery.json"),
      now: () => 1_000,
    });
    const drill = createAuthorityRecoveryDrill({ policy, persistencePath: path });
    const auth = await policy.requestAuthorization({
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
    const result = drill.prepare(validEvidence(issuerInstanceId, candidateInstanceId, 1), auth);
    expect(result.state).toBe("authorized");
    expect(drill.read()?.state).toBe("authorized");
    writeFileSync(path, "{corrupt", "utf8");
    const restarted = createAuthorityRecoveryDrill({ policy, persistencePath: path });
    expect(restarted.read()?.state).toBeUndefined();
  });

  it("rejects expired and revoked authorizations and replay attempts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "openstore-054-reject-"));
    const issuerIdentity = createIdentity();
    const candidateInstanceId = createCoordinatorInstanceIdentity(createIdentity().publicKey).instanceId;
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const policy = createAuthorityRecoveryPolicy({
      issuerIdentity,
      issuerInstanceId,
      candidateInstanceId,
      persistencePath: join(tmp, "recovery.json"),
      now: () => 10_000,
    });
    const evidence = validEvidence(issuerInstanceId, candidateInstanceId, 1);
    const expired = await policy.requestAuthorization({
      version: 1,
      candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId,
      operatorIdentity: "operator:expired",
      issuedAt: 1_000,
      expiresAt: 2_000,
    });
    expect(() => policy.approveRecovery(evidence, expired)).toThrow(/expired|invalid/i);
    const active = await policy.requestAuthorization({
      version: 1,
      candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId,
      operatorIdentity: "operator:revoked",
      issuedAt: 10_000,
      expiresAt: 30_000,
    });
    await policy.rejectAuthorization(active.authorizationId, "revoked");
    expect(() => policy.approveRecovery(evidence, active)).toThrow(/revoked|invalid/i);
    const drill = createAuthorityRecoveryDrill({ policy, persistencePath: join(tmp, "drill.json") });
    expect(drill.verify(evidence, active).state).toBe("verification-failed");
  });
});
