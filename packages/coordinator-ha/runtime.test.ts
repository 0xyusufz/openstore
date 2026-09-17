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
import { EventStore } from "../events/index.js";
import { MetricsRegistry } from "../metrics/index.js";
import { ConditionEvaluator } from "../conditions/index.js";

function fixture(
  dir = mkdtempSync(join(tmpdir(), "openstore-053n-")),
  identities?: { issuerIdentity: ReturnType<typeof createIdentity>; candidateIdentity: ReturnType<typeof createIdentity> },
  observability?: { events: EventStore; metrics: MetricsRegistry; conditions: ConditionEvaluator },
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
  const runtime = createCoordinatorAuthorityRuntime({ controlPlane, issuer, ownership, candidate, issuerInstanceId: issuerInstance.instanceId, ...observability });
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

  it("emits bounded sanitized observability for runtime and ownership transitions", async () => {
    const events = new EventStore(5);
    const metrics = new MetricsRegistry(32);
    const conditions = new ConditionEvaluator();
    const f = fixture(undefined, undefined, { events, metrics, conditions });
    await f.issuer.bootstrap(1);
    await f.runtime.start();
    expect(events.recent().some((event) => event.type === "authority.runtime.started")).toBe(true);
    expect(f.runtime.status().conditions.some((condition) => condition.id === "authority_runtime_ready")).toBe(true);
    const grant = await f.controlPlane.issueGrant(f.request);
    await f.controlPlane.deliverGrant(grant);
    await f.candidate.acceptGrant(grant);
    await f.runtime.establishOwnership();
    await f.runtime.releaseOwnership("operator");
    await f.runtime.fenceOwner("operator");
    await f.runtime.stop();
    expect(metrics.snapshot().counters.some((metric) => metric.name === "authority_ownership_establish_success_total")).toBe(true);
    expect(metrics.snapshot().counters.some((metric) => metric.name === "authority_ownership_releases_total")).toBe(true);
    expect(metrics.snapshot().counters.some((metric) => metric.name === "authority_owner_fencing_total")).toBe(true);
    expect(events.snapshot().length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(events.snapshot())).not.toMatch(/private|secret|token|grant|path/i);
  });

  it("observes token validation and revoked-grant rejection without promotion", async () => {
    const events = new EventStore(20);
    const metrics = new MetricsRegistry(32);
    const f = fixture(undefined, undefined, { events, metrics, conditions: new ConditionEvaluator() });
    await f.issuer.bootstrap(1);
    await f.runtime.start();
    expect(f.runtime.validateOwnershipToken({} as never)).toBe(false);
    const grant = await f.controlPlane.issueGrant(f.request);
    await f.issuer.revoke(grant.grantId, f.caller);
    f.revoked.add(grant.grantId);
    await f.controlPlane.deliverGrant(grant);
    await expect(f.runtime.establishOwnership()).rejects.toThrow(/revoked/);
    expect(metrics.snapshot().counters.some((metric) => metric.name === "authority_token_validation_failures_total")).toBe(true);
    expect(metrics.snapshot().counters.some((metric) => metric.name === "authority_revoked_grant_rejections_total")).toBe(true);
    expect(events.recent().some((event) => event.type === "authority.token.rejected")).toBe(true);
    expect(events.recent().some((event) => event.type === "authority.grant.revoked")).toBe(true);
    expect(f.runtime.status().authority.placementAuthorized).toBe(false);
  });

  it("classifies missing and corrupt startup state without promoting", async () => {
    const missing = fixture();
    await missing.runtime.start();
    expect(missing.runtime.status()).toMatchObject({ failureCode: "missing_issuer", authority: { placementAuthorized: false } });
    const corruptDir = mkdtempSync(join(tmpdir(), "openstore-053n-corrupt-"));
    writeFileSync(join(corruptDir, "issuer.json"), "{broken", "utf8");
    const corrupt = fixture(corruptDir);
    await expect(corrupt.runtime.start()).rejects.toThrow(/corrupt/);
    expect(corrupt.runtime.status()).toMatchObject({ failureCode: "corrupt_issuer", state: "degraded", authority: { placementAuthorized: false } });
  });
});
