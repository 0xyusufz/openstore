import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createAuthorityGrantService } from "./authority-grant.js";
import { createAuthorityIssuer } from "./authority-issuer.js";
import { createAuthorityOwnershipService } from "./authority-ownership.js";
import { createAuthorityControlPlane } from "./authority-control-plane.js";
import { createCoordinatorAuthorityRuntime } from "./runtime.js";

function fixture(
  dir = mkdtempSync(join(tmpdir(), "openstore-053n-")),
  identities?: { issuerIdentity: ReturnType<typeof createIdentity>; candidateIdentity: ReturnType<typeof createIdentity> },
) {
  const issuerIdentity = identities?.issuerIdentity ?? createIdentity();
  const candidateIdentity = identities?.candidateIdentity ?? createIdentity();
  const issuerInstance = createCoordinatorInstanceIdentity(issuerIdentity.publicKey);
  const candidateInstance = createCoordinatorInstanceIdentity(candidateIdentity.publicKey);
  const caller = "operator:runtime";
  const authorizer = { authenticate: (value: string) => value === caller, mayIssue: (value: string) => value === caller };
  const issuer = createAuthorityIssuer({ identity: issuerIdentity, persistencePath: join(dir, "issuer.json"), authorizer, now: () => 5_000 });
  const revoked = new Set<string>();
  const candidate = createAuthorityGrantService({
    instance: candidateInstance, trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
    persistencePath: join(dir, "candidate.json"), now: () => 5_000,
    revokedGrantIds: () => [...revoked], state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
  });
  const ownership = createAuthorityOwnershipService({
    instance: candidateInstance, issuerPrivateKey: issuerIdentity.privateKey,
    trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
    persistencePath: join(dir, "ownership.json"), now: () => 5_000,
    revokedGrantIds: () => [...revoked], state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
  });
  const controlPlane = createAuthorityControlPlane({
    issuer, candidate, ownership, candidateInstanceId: candidateInstance.instanceId, issuerInstanceId: issuerInstance.instanceId,
    revokedGrantIds: () => [...revoked],
  });
  const runtime = createCoordinatorAuthorityRuntime({ controlPlane, issuer, ownership, candidate, issuerInstanceId: issuerInstance.instanceId });
  const request = { operation: "request-grant" as const, version: 1 as const, callerIdentity: caller, candidateInstanceId: candidateInstance.instanceId, authorityEpoch: 1, stateRevision: 7, stateDigest: "a".repeat(64), grantId: "runtime-grant", issuedAt: 1_000, expiresAt: 10_000 };
  return { dir, issuerIdentity, candidateIdentity, issuer, candidate, ownership, controlPlane, runtime, request, revoked, caller, candidateInstance, issuerInstance, authorizer };
}

describe("coordinator authority runtime", () => {
  it("restores valid state and delegates explicit ownership lifecycle", async () => {
    const f = fixture();
    await f.issuer.bootstrap(1);
    await f.runtime.start();
    const grant = await f.controlPlane.issueGrant(f.request);
    await f.controlPlane.deliverGrant(grant);
    await f.candidate.acceptGrant(grant);
    await f.runtime.establishOwnership();
    expect(f.runtime.status()).toMatchObject({ state: "running", authority: { placementAuthorized: true }, ownership: { state: "authoritative" } });
    await f.runtime.fenceOwner("operator");
    expect(f.runtime.status().ownership.state).toBe("fenced");
    await f.runtime.stop();
    await f.runtime.stop();
  });

  it("keeps missing state non-authoritative and corrupt state degraded", async () => {
    const f = fixture();
    await f.runtime.start();
    expect(f.runtime.status().authority.placementAuthorized).toBe(false);
    await f.runtime.stop();
    writeFileSync(join(f.dir, "issuer.json"), "{corrupt", "utf8");
    const corrupt = fixture(f.dir);
    await expect(corrupt.runtime.start()).rejects.toThrow(/invalid/);
    expect(corrupt.runtime.status().state).toBe("degraded");
    expect(corrupt.runtime.status().authority.placementAuthorized).toBe(false);
  });

  it("rejects persisted cross-state epoch and issuer identity mismatches", async () => {
    const f = fixture();
    await f.issuer.bootstrap(1);
    await f.runtime.start();
    const grant = await f.controlPlane.issueGrant(f.request);
    await f.controlPlane.deliverGrant(grant);
    await f.candidate.acceptGrant(grant);
    await f.runtime.establishOwnership();

    const issuerState = JSON.parse(readFileSync(join(f.dir, "issuer.json"), "utf8"));
    issuerState.authorityEpoch = 2;
    writeFileSync(join(f.dir, "issuer.json"), JSON.stringify(issuerState), "utf8");
    const restarted = fixture(f.dir, { issuerIdentity: f.issuerIdentity, candidateIdentity: f.candidateIdentity });
    await expect(restarted.runtime.start()).rejects.toThrow(/invalid/);
  });

  it("does not restore authority when issuer persistence is missing", async () => {
    const f = fixture();
    await f.issuer.bootstrap(1);
    await f.runtime.start();
    const grant = await f.controlPlane.issueGrant(f.request);
    await f.controlPlane.deliverGrant(grant);
    await f.candidate.acceptGrant(grant);
    await f.runtime.establishOwnership();
    unlinkSync(join(f.dir, "issuer.json"));
    const restarted = fixture(f.dir, { issuerIdentity: f.issuerIdentity, candidateIdentity: f.candidateIdentity });
    await restarted.runtime.start();
    expect(restarted.runtime.status().authority.placementAuthorized).toBe(false);
  });

  it("rejects ownership epoch and issuer identity mismatches", async () => {
    const f = fixture();
    await f.issuer.bootstrap(1);
    await f.runtime.start();
    const grant = await f.controlPlane.issueGrant(f.request);
    await f.controlPlane.deliverGrant(grant);
    await f.candidate.acceptGrant(grant);
    await f.runtime.establishOwnership();
    const ownershipState = JSON.parse(readFileSync(join(f.dir, "ownership.json"), "utf8"));
    ownershipState.authorityEpoch = 2;
    writeFileSync(join(f.dir, "ownership.json"), JSON.stringify(ownershipState), "utf8");
    const restarted = fixture(f.dir, { issuerIdentity: f.issuerIdentity, candidateIdentity: f.candidateIdentity });
    await expect(restarted.runtime.start()).rejects.toThrow(/invalid/);
  });

  it("rejects ownership records bound to another issuer", async () => {
    const f = fixture();
    await f.issuer.bootstrap(1);
    await f.runtime.start();
    const grant = await f.controlPlane.issueGrant(f.request);
    await f.controlPlane.deliverGrant(grant);
    await f.candidate.acceptGrant(grant);
    await f.runtime.establishOwnership();
    const ownershipState = JSON.parse(readFileSync(join(f.dir, "ownership.json"), "utf8"));
    ownershipState.issuerInstanceId = "coord-11111111111111111111111111111111";
    writeFileSync(join(f.dir, "ownership.json"), JSON.stringify(ownershipState), "utf8");
    const restarted = fixture(f.dir, { issuerIdentity: f.issuerIdentity, candidateIdentity: f.candidateIdentity });
    await expect(restarted.runtime.start()).rejects.toThrow(/invalid/);
  });

  it("rejects expired/revoked grants before runtime ownership can change", async () => {
    const f = fixture();
    await f.issuer.bootstrap(1);
    await f.runtime.start();
    const grant = await f.controlPlane.issueGrant(f.request);
    await f.issuer.revoke(grant.grantId, f.caller);
    f.revoked.add(grant.grantId);
    await f.controlPlane.deliverGrant(grant);
    await expect(f.runtime.establishOwnership()).rejects.toThrow(/revoked/);
    expect(f.runtime.status().authority.placementAuthorized).toBe(false);
  });

  it("has no automatic promotion or token bypass", async () => {
    const f = fixture();
    await f.runtime.start();
    expect(f.runtime.status().authority.placementAuthorized).toBe(false);
    expect(f.runtime.validateOwnershipToken({} as never)).toBe(false);
    await expect(f.runtime.establishOwnership()).rejects.toThrow(/token/);
  });
});
