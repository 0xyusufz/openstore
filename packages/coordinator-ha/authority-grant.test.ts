import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createAuthorityGrantService, createSignedAuthorityGrant } from "./authority-grant.js";

function setup(path?: string, existing?: { issuer: ReturnType<typeof createIdentity>; candidate: ReturnType<typeof createIdentity> }) {
  const issuer = existing?.issuer ?? createIdentity();
  const candidate = existing?.candidate ?? createIdentity();
  const instance = createCoordinatorInstanceIdentity(candidate.publicKey);
  const issuerInstance = createCoordinatorInstanceIdentity(issuer.publicKey);
  const service = createAuthorityGrantService({
    instance, trustedIssuerPublicKeys: [issuer.publicKey.toString("base64")], persistencePath: path,
    now: () => 5_000,
    state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
  });
  const make = (overrides: Partial<Parameters<typeof createSignedAuthorityGrant>[0]> = {}) => createSignedAuthorityGrant({
    version: 1, candidateInstanceId: instance.instanceId, authorityEpoch: 1, stateRevision: 7,
    stateDigest: "a".repeat(64), grantId: "grant-1", issuedAt: 1_000, expiresAt: 10_000,
    issuerInstanceId: issuerInstance.instanceId, issuerPublicKey: issuer.publicKey.toString("base64"), ...overrides,
  }, issuer.privateKey);
  return { service, make, instance, issuer, candidate };
}

describe("explicit authority grants", () => {
  it("promotes only with a valid signed grant and is idempotent", async () => {
    const { service, make } = setup();
    await service.acceptGrant(make());
    expect(service.inspectState()).toMatchObject({ state: "authoritative", acceptedGrantId: "grant-1", authorityEpoch: 1 });
    await service.acceptGrant(make());
    await expect(service.acceptGrant(make({ grantId: "grant-2" }))).rejects.toThrow(/conflicting/);
  });

  it("rejects identity, issuer, signature, freshness, and state failures", async () => {
    const { service, make, issuer } = setup();
    await expect(service.acceptGrant(make({ candidateInstanceId: "coord-ffffffffffffffffffffffffffffffff" }))).rejects.toThrow(/candidate/);
    await expect(service.acceptGrant({ ...make(), signature: "bad" })).rejects.toThrow(/signature/);
    const other = createIdentity();
    const untrusted = createSignedAuthorityGrant({ ...make(), issuerPublicKey: other.publicKey.toString("base64"), issuerInstanceId: "coord-ffffffffffffffffffffffffffffffff" }, other.privateKey);
    await expect(service.acceptGrant(untrusted)).rejects.toThrow(/untrusted/);
    await expect(service.acceptGrant(make({ expiresAt: 4_000 }))).rejects.toThrow(/stale|expired/);
    await expect(service.acceptGrant(make({ stateRevision: 8 }))).rejects.toThrow(/state/);
    void issuer;
  });

  it("persists authority and demotion, while corrupt state is non-authoritative", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053i-"));
    const path = join(dir, "authority.json");
    const first = setup(path);
    await first.service.acceptGrant(first.make());
    const second = setup(path, first);
    expect(second.service.inspectState()).toMatchObject({ state: "authoritative", authorityEpoch: 1 });
    await second.service.revoke("operator");
    expect(second.service.inspectState().state).toBe("revoked");
    writeFileSync(path, "{corrupt", "utf8");
    const recovered = setup(path);
    expect(recovered.service.inspectState().state).toBe("non-authoritative");
  });

  it("does not promote from local availability or latest revision alone", async () => {
    const { service } = setup();
    expect((await service.inspectAuthority()).placementAuthorized).toBe(false);
    await expect(service.requestPromotion({
      version: 1, candidate: createCoordinatorInstanceIdentity(createIdentity().publicKey), requestedAt: Date.now(),
      evidence: { version: 1, instanceId: "coord-0123456789abcdef0123456789abcdef", stateRevision: 99, stateDigest: "a".repeat(64), proofVerified: true, sourceTrusted: true, fresh: true, explicitlyAuthorized: false, antiReplayValid: true, splitBrainFree: true },
    })).rejects.toThrow(/external operator/);
  });
});
