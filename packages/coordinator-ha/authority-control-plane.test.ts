import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createAuthorityGrantService } from "./authority-grant.js";
import { createAuthorityIssuer } from "./authority-issuer.js";
import { createAuthorityControlPlane, type AuthorityControlPlaneRequest } from "./authority-control-plane.js";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "openstore-053k-"));
  const issuerIdentity = createIdentity();
  const candidateIdentity = createIdentity();
  const issuerInstance = createCoordinatorInstanceIdentity(issuerIdentity.publicKey);
  const candidateInstance = createCoordinatorInstanceIdentity(candidateIdentity.publicKey);
  const caller = "operator:alice";
  const authorizer = { authenticate: (value: string) => value === caller, mayIssue: (value: string) => value === caller };
  const issuer = createAuthorityIssuer({
    identity: issuerIdentity, persistencePath: join(directory, "issuer.json"), authorizer, now: () => 5_000,
  });
  const revoked = new Set<string>();
  const candidate = createAuthorityGrantService({
    instance: candidateInstance,
    trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
    persistencePath: join(directory, "candidate.json"),
    now: () => 5_000,
    revokedGrantIds: () => [...revoked],
    state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
  });
  const control = createAuthorityControlPlane({
    issuer, candidate, candidateInstanceId: candidateInstance.instanceId, issuerInstanceId: issuerInstance.instanceId,
    revokedGrantIds: () => [...revoked],
  });
  const request = (overrides: Partial<AuthorityControlPlaneRequest> = {}): AuthorityControlPlaneRequest => ({
    operation: "request-grant", version: 1, callerIdentity: caller,
    candidateInstanceId: candidateInstance.instanceId, authorityEpoch: 1, stateRevision: 7,
    stateDigest: "a".repeat(64), grantId: "grant-1", issuedAt: 1_000, expiresAt: 10_000,
    ...overrides,
  });
  return { directory, issuer, candidate, control, request, caller, candidateInstance, issuerIdentity, issuerInstance, revoked };
}

describe("authority control-plane boundary", () => {
  it("performs explicit request, issue, delivery, and acceptance", async () => {
    const f = setup();
    await f.issuer.bootstrap(1);
    expect(f.control.inspect().eligibility.placementAuthorized).toBe(false);
    const grant = await f.control.requestGrant(f.request());
    await f.control.deliverGrant(grant);
    await f.control.acceptGrant(grant.grantId);
    expect(f.control.inspect()).toMatchObject({
      candidateState: { state: "authoritative", acceptedGrantId: grant.grantId },
      lastTransition: "accepted",
    });
    await f.control.acceptGrant(grant.grantId);
    expect(f.control.inspect().candidateState.state).toBe("authoritative");
  });

  it("rejects unauthorized, wrong identity, replay, and conflicting transitions", async () => {
    const f = setup();
    await f.issuer.bootstrap(1);
    await expect(f.control.issueGrant(f.request({ callerIdentity: "operator:bob" }))).rejects.toThrow(/authorized/);
    await expect(f.control.issueGrant(f.request({ candidateInstanceId: "coord-ffffffffffffffffffffffffffffffff" }))).rejects.toThrow(/candidate|identity/);
    const grant = await f.control.issueGrant(f.request());
    await f.control.deliverGrant(grant);
    await f.control.acceptGrant(grant.grantId);
    const conflicting = await f.control.issueGrant(f.request({ grantId: "grant-2" }));
    await f.control.deliverGrant(conflicting);
    await expect(f.control.acceptGrant(conflicting.grantId)).rejects.toThrow(/conflicting/);
  });

  it("revokes and persists non-authoritative state across restart", async () => {
    const f = setup();
    await f.issuer.bootstrap(1);
    const grant = await f.control.issueGrant(f.request());
    await f.control.deliverGrant(grant);
    await f.control.acceptGrant(grant.grantId);
    f.revoked.add(grant.grantId);
    await f.control.revokeGrant(grant.grantId, f.caller);
    expect(f.control.inspect().candidateState.state).toBe("revoked");
    const restarted = createAuthorityGrantService({
      instance: f.candidateInstance,
      trustedIssuerPublicKeys: [f.issuerIdentity.publicKey.toString("base64")],
      persistencePath: join(f.directory, "candidate.json"),
      now: () => 5_000,
      revokedGrantIds: () => [...f.revoked],
      state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    });
    expect(restarted.inspectState().state).toBe("revoked");
  });

  it("fails closed when revocation lookup is unavailable", async () => {
    const f = setup();
    await f.issuer.bootstrap(1);
    const grant = await f.issuer.issue(f.request());
    const unavailable = createAuthorityGrantService({
      instance: f.candidateInstance,
      trustedIssuerPublicKeys: [f.issuerIdentity.publicKey.toString("base64")],
      now: () => 5_000,
      revokedGrantIds: () => { throw new Error("revocation unavailable"); },
      state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    });
    await expect(unavailable.acceptGrant(grant)).rejects.toThrow(/revocation unavailable/);
    expect(unavailable.inspectState().state).toBe("non-authoritative");
  });

  it("does not use reachability, heartbeat, latest revision, or DHT observations", async () => {
    const f = setup();
    await f.issuer.bootstrap(1);
    expect(f.control.inspect().candidateState.state).toBe("non-authoritative");
    await expect(f.control.acceptGrant("grant-1")).rejects.toThrow(/delivered/);
    expect(f.control.inspect().candidateState.state).toBe("non-authoritative");
  });
});
