import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createAuthorityGrantService } from "./authority-grant.js";
import { createAuthorityIssuer } from "./authority-issuer.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "openstore-053l-"));
  const issuerIdentity = createIdentity();
  const candidateIdentity = createIdentity();
  const issuerInstance = createCoordinatorInstanceIdentity(issuerIdentity.publicKey);
  const candidateInstance = createCoordinatorInstanceIdentity(candidateIdentity.publicKey);
  const caller = "operator:revocation";
  const authorizer = { authenticate: (value: string) => value === caller, mayIssue: (value: string) => value === caller };
  const issuer = createAuthorityIssuer({
    identity: issuerIdentity, persistencePath: join(dir, "issuer.json"), authorizer, now: () => 5_000,
  });
  const revoked = new Set<string>();
  const candidate = createAuthorityGrantService({
    instance: candidateInstance,
    trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
    persistencePath: join(dir, "candidate.json"),
    now: () => 5_000,
    revokedGrantIds: () => [...revoked],
    state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
  });
  return { dir, issuer, candidate, revoked, caller, issuerIdentity, issuerInstance, candidateInstance, authorizer };
}

describe("durable authority revocation", () => {
  it("is idempotent for identical metadata and rejects conflicting metadata", async () => {
    const f = setup(); await f.issuer.bootstrap(1);
    const grant = await f.issuer.issue({
      version: 1, callerIdentity: f.caller, candidateInstanceId: f.candidateInstance.instanceId,
      authorityEpoch: 1, stateRevision: 7, stateDigest: "a".repeat(64), grantId: "revoke-1", issuedAt: 1_000, expiresAt: 10_000,
    });
    const first = await f.issuer.revoke(grant.grantId, f.caller, "incident");
    const second = await f.issuer.revoke(grant.grantId, f.caller, "incident");
    expect(second).toEqual(first);
    await expect(f.issuer.revoke(grant.grantId, f.caller, "different")).rejects.toThrow(/conflicting/);
    expect(f.issuer.inspectRevocation(grant.grantId)).toMatchObject({ recordId: "revoke-revoke-1", reason: "incident" });
  });

  it("rejects revoked grants across restart and newer revisions", async () => {
    const f = setup(); await f.issuer.bootstrap(1);
    const grant = await f.issuer.issue({
      version: 1, callerIdentity: f.caller, candidateInstanceId: f.candidateInstance.instanceId,
      authorityEpoch: 1, stateRevision: 7, stateDigest: "a".repeat(64), grantId: "revoke-2", issuedAt: 1_000, expiresAt: 10_000,
    });
    await f.issuer.revoke(grant.grantId, f.caller, "operator");
    f.revoked.add(grant.grantId);
    await expect(f.candidate.acceptGrant(grant)).rejects.toThrow(/revoked/);
    const restartedIssuer = createAuthorityIssuer({ identity: f.issuerIdentity, persistencePath: join(f.dir, "issuer.json"), authorizer: f.authorizer, now: () => 5_000 });
    expect(restartedIssuer.isRevoked(grant.grantId)).toBe(true);
    const restartedCandidate = createAuthorityGrantService({
      instance: f.candidateInstance,
      trustedIssuerPublicKeys: [f.issuerIdentity.publicKey.toString("base64")],
      persistencePath: join(f.dir, "candidate.json"),
      now: () => 5_000,
      revokedGrantIds: () => [grant.grantId],
      state: () => ({ revision: 8, digest: "b".repeat(64), fresh: true }),
    });
    await expect(restartedCandidate.acceptGrant({ ...grant, stateRevision: 8, stateDigest: "b".repeat(64) })).rejects.toThrow(/revoked/);
  });

  it("fails closed for unavailable or malformed revocation state", async () => {
    const f = setup(); await f.issuer.bootstrap(1);
    const grant = await f.issuer.issue({
      version: 1, callerIdentity: f.caller, candidateInstanceId: f.candidateInstance.instanceId,
      authorityEpoch: 1, stateRevision: 7, stateDigest: "a".repeat(64), grantId: "revoke-3", issuedAt: 1_000, expiresAt: 10_000,
    });
    const unavailable = createAuthorityGrantService({
      instance: f.candidateInstance, trustedIssuerPublicKeys: [f.issuerIdentity.publicKey.toString("base64")],
      now: () => 5_000, revokedGrantIds: () => { throw new Error("revocation unavailable"); },
      state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    });
    await expect(unavailable.acceptGrant(grant)).rejects.toThrow(/unavailable/);
    const malformed = createAuthorityGrantService({
      instance: f.candidateInstance, trustedIssuerPublicKeys: [f.issuerIdentity.publicKey.toString("base64")],
      now: () => 5_000, revokedGrantIds: () => [7 as unknown as string],
      state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    });
    await expect(malformed.acceptGrant(grant)).rejects.toThrow(/malformed/);
  });

  it("treats corrupted durable issuer revocation state as unavailable", async () => {
    const f = setup(); await f.issuer.bootstrap(1);
    await f.issuer.issue({
      version: 1, callerIdentity: f.caller, candidateInstanceId: f.candidateInstance.instanceId,
      authorityEpoch: 1, stateRevision: 7, stateDigest: "a".repeat(64), grantId: "revoke-4", issuedAt: 1_000, expiresAt: 10_000,
    });
    writeFileSync(join(f.dir, "issuer.json"), "{corrupt", "utf8");
    const corrupt = createAuthorityIssuer({ identity: f.issuerIdentity, persistencePath: join(f.dir, "issuer.json"), authorizer: f.authorizer });
    expect(corrupt.inspect().persistenceHealthy).toBe(false);
    expect(corrupt.inspect().initialized).toBe(false);
    await expect(corrupt.bootstrap(1)).rejects.toThrow(/unavailable/);
  });
});
