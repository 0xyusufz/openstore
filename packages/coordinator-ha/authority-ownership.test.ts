import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createSignedAuthorityGrant } from "./authority-grant.js";
import { createAuthorityOwnershipService } from "./authority-ownership.js";

function setup(path = join(mkdtempSync(join(tmpdir(), "openstore-053m-")), "owner.json")) {
  const issuer = createIdentity(); const candidate = createIdentity();
  const issuerInstance = createCoordinatorInstanceIdentity(issuer.publicKey);
  const candidateInstance = createCoordinatorInstanceIdentity(candidate.publicKey);
  const service = createAuthorityOwnershipService({
    instance: candidateInstance, issuerPrivateKey: issuer.privateKey,
    trustedIssuerPublicKeys: [issuer.publicKey.toString("base64")], persistencePath: path,
    now: () => 5_000, revokedGrantIds: () => [],
    state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
  });
  const grant = (epoch = 1, grantId = `grant-${epoch}`) => createSignedAuthorityGrant({
    version: 1, candidateInstanceId: candidateInstance.instanceId, authorityEpoch: epoch,
    stateRevision: 7, stateDigest: "a".repeat(64), grantId, issuedAt: 1_000, expiresAt: 10_000,
    issuerInstanceId: issuerInstance.instanceId, issuerPublicKey: issuer.publicKey.toString("base64"),
  }, issuer.privateKey);
  return { service, grant, issuer, candidateInstance, path };
}

describe("authority ownership and fencing", () => {
  it("establishes ownership and makes exact reapplication idempotent", async () => {
    const f = setup(); const token = f.service.createToken(f.grant());
    await f.service.establishOwnership(token); await f.service.establishOwnership(token);
    expect(f.service.inspectOwnership()).toMatchObject({ state: "authoritative", ownerInstanceId: f.candidateInstance.instanceId, tokenId: token.tokenId });
  });

  it("rejects a second owner at the same epoch and invalid tokens", async () => {
    const f = setup(); const token = f.service.createToken(f.grant());
    await f.service.establishOwnership(token);
    const other = setup();
    const otherToken = other.service.createToken(other.grant());
    await expect(f.service.establishOwnership(otherToken)).rejects.toThrow(/invalid|conflict/);
    await expect(f.service.establishOwnership({ ...token, signature: "bad" })).rejects.toThrow(/signature/);
  });

  it("supports explicit higher epoch transition and rejects old tokens", async () => {
    const f = setup(); const first = f.service.createToken(f.grant(1));
    await f.service.establishOwnership(first); await f.service.fenceOwner("operator");
    const second = f.service.createToken(f.grant(2, "grant-2"));
    await f.service.establishOwnership(second);
    expect(f.service.inspectOwnership()).toMatchObject({ state: "authoritative", authorityEpoch: 2 });
    await expect(f.service.establishOwnership(first)).rejects.toThrow(/stale|fenced|conflict/);
  });

  it("persists release/fencing and fails closed on corrupt state", async () => {
    const f = setup(); const token = f.service.createToken(f.grant());
    await f.service.establishOwnership(token); await f.service.releaseOwnership("operator");
    const restarted = setup(f.path);
    expect(restarted.service.inspectOwnership().state).toBe("released");
    writeFileSync(f.path, "{bad", "utf8");
    const corrupt = setup(f.path);
    expect(corrupt.service.validateOwnershipToken(token)).toBe(false);
    await expect(corrupt.service.establishOwnership(token)).rejects.toThrow();
  });

  it("rejects revoked, mismatched, and non-authority-derived tokens", async () => {
    const f = setup(); const revoked = setup();
    const revokedTokenService = createAuthorityOwnershipService({
      instance: f.candidateInstance, issuerPrivateKey: f.issuer.privateKey,
      trustedIssuerPublicKeys: [f.issuer.publicKey.toString("base64")], persistencePath: join(mkdtempSync(join(tmpdir(), "openstore-053m-")), "revoked.json"),
      now: () => 5_000, revokedGrantIds: () => ["grant-1"], state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    });
    const token = revokedTokenService.createToken(f.grant());
    await expect(revokedTokenService.establishOwnership(token)).rejects.toThrow(/revoked/);
    expect(f.service.inspectOwnership().state).toBe("non-authoritative");
    void revoked;
  });
});
