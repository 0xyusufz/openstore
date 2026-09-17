import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createAuthorityGrantService } from "./authority-grant.js";
import { createAuthorityIssuer, type AuthorityIssuanceRequest } from "./authority-issuer.js";

function fixture(path: string, now = 5_000) {
  const issuerIdentity = createIdentity();
  const candidateIdentity = createIdentity();
  const issuerInstance = createCoordinatorInstanceIdentity(issuerIdentity.publicKey);
  const candidateInstance = createCoordinatorInstanceIdentity(candidateIdentity.publicKey);
  const operator = "operator:alice";
  const authorizer = {
    authenticate: (caller: string) => caller === operator,
    mayIssue: (caller: string) => caller === operator,
  };
  const issuer = createAuthorityIssuer({ identity: issuerIdentity, persistencePath: path, authorizer, now: () => now });
  const request = (overrides: Partial<AuthorityIssuanceRequest> = {}): AuthorityIssuanceRequest => ({
    version: 1, callerIdentity: operator, candidateInstanceId: candidateInstance.instanceId,
    authorityEpoch: 1, stateRevision: 7, stateDigest: "a".repeat(64), grantId: "grant-1",
    issuedAt: 1_000, expiresAt: 10_000, ...overrides,
  });
  return { issuer, request, issuerIdentity, candidateIdentity, issuerInstance, candidateInstance, operator, authorizer };
}

describe("trusted authority issuer", () => {
  it("requires explicit bootstrap and authorized issuance, producing a 053I grant", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "openstore-053j-")), "issuer.json");
    const fixtureData = fixture(path);
    await expect(fixtureData.issuer.issue(fixtureData.request())).rejects.toThrow(/initialized/);
    await fixtureData.issuer.bootstrap(1);
    const grant = await fixtureData.issuer.issue(fixtureData.request());
    const candidate = createAuthorityGrantService({
      instance: fixtureData.candidateInstance,
      trustedIssuerPublicKeys: [fixtureData.issuerIdentity.publicKey.toString("base64")],
      now: () => 5_000,
      state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    });
    await candidate.acceptGrant(grant);
    expect(candidate.inspectState().state).toBe("authoritative");
  });

  it("rejects unauthorized callers, self-issuance, invalid state, and duplicate IDs", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "openstore-053j-")), "issuer.json");
    const f = fixture(path); await f.issuer.bootstrap(1);
    await expect(f.issuer.issue(f.request({ callerIdentity: "operator:bob" }))).rejects.toThrow(/authorized/);
    await expect(f.issuer.issue(f.request({ callerIdentity: f.candidateInstance.instanceId }))).rejects.toThrow(/authorized|candidate/);
    await expect(f.issuer.issue(f.request({ stateDigest: "bad" }))).rejects.toThrow(/invalid/);
    await f.issuer.issue(f.request());
    await expect(f.issuer.issue(f.request({ stateRevision: 8 }))).rejects.toThrow(/used/);
    expect(f.issuer.audits()[0]).not.toHaveProperty("privateKey");
  });

  it("persists epoch/audits, rejects corrupt state, and supports revocation", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "openstore-053j-")), "issuer.json");
    const f = fixture(path); await f.issuer.bootstrap(4);
    const grant = await f.issuer.issue(f.request({ authorityEpoch: 4 }));
    const candidate = createAuthorityGrantService({
      instance: f.candidateInstance,
      trustedIssuerPublicKeys: [f.issuerIdentity.publicKey.toString("base64")],
      now: () => 5_000,
      revokedGrantIds: () => f.issuer.isRevoked(grant.grantId) ? [grant.grantId] : [],
      state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    });
    await f.issuer.revoke(grant.grantId, f.operator);
    expect(f.issuer.isRevoked(grant.grantId)).toBe(true);
    await expect(candidate.acceptGrant(grant)).rejects.toThrow(/revoked/);
    const restarted = createAuthorityIssuer({ identity: f.issuerIdentity, persistencePath: path, authorizer: f.authorizer, now: () => 5_000 });
    expect(restarted.inspect()).toMatchObject({ initialized: true, authorityEpoch: 4, auditCount: 1 });
    writeFileSync(path, "{bad", "utf8");
    const corrupt = createAuthorityIssuer({ identity: f.issuerIdentity, persistencePath: path, authorizer: f.authorizer });
    expect(corrupt.inspect()).toMatchObject({ initialized: false, persistenceHealthy: false });
    await expect(corrupt.bootstrap(1)).rejects.toThrow(/unavailable/);
  });

  it("does not derive issuance from reachability or latest revision", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "openstore-053j-")), "issuer.json");
    const f = fixture(path); await f.issuer.bootstrap(1);
    await expect(f.issuer.issue(f.request({ callerIdentity: "dht:peer", stateRevision: 999 }))).rejects.toThrow(/authorized/);
    expect(f.issuer.audits()).toHaveLength(0);
  });
});
