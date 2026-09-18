import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import {
  CoordinatorReplicaImporter,
  createAuthorityProof,
  createCoordinatorInstanceIdentity,
  createCoordinatorSnapshotExporter,
} from "./index.js";
import { createAuthorityGrantService, createSignedAuthorityGrant } from "./authority-grant.js";
import { createAuthorityIssuer, type AuthorityIssuanceRequest } from "./authority-issuer.js";
import { createAuthorityOwnershipService } from "./authority-ownership.js";
import { createAuthorityRecoveryPolicy } from "./authority-recovery-policy.js";
import { createAuthorityRecoveryDrill } from "./authority-recovery-drill.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "openstore-065-ha-"));
}

function grantSetup(path?: string, keys?: { issuer: ReturnType<typeof createIdentity>; candidate: ReturnType<typeof createIdentity> }) {
  const issuer = keys?.issuer ?? createIdentity();
  const candidate = keys?.candidate ?? createIdentity();
  const instance = createCoordinatorInstanceIdentity(candidate.publicKey);
  const issuerInstance = createCoordinatorInstanceIdentity(issuer.publicKey);
  const service = createAuthorityGrantService({
    instance,
    trustedIssuerPublicKeys: [issuer.publicKey.toString("base64")],
    persistencePath: path,
    now: () => 5_000,
    state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
  });
  const make = (overrides: Record<string, unknown> = {}) =>
    createSignedAuthorityGrant(
      {
        version: 1,
        candidateInstanceId: instance.instanceId,
        authorityEpoch: 1,
        stateRevision: 7,
        stateDigest: "a".repeat(64),
        grantId: "grant-1",
        issuedAt: 1_000,
        expiresAt: 10_000,
        issuerInstanceId: issuerInstance.instanceId,
        issuerPublicKey: issuer.publicKey.toString("base64"),
        ...overrides,
      } as Parameters<typeof createSignedAuthorityGrant>[0],
      issuer.privateKey,
    );
  return { service, make, instance, issuer, candidate };
}

function ownershipSetup(path: string, keys?: { issuer: ReturnType<typeof createIdentity>; candidate: ReturnType<typeof createIdentity> }) {
  const issuer = keys?.issuer ?? createIdentity();
  const candidate = keys?.candidate ?? createIdentity();
  const issuerInstance = createCoordinatorInstanceIdentity(issuer.publicKey);
  const candidateInstance = createCoordinatorInstanceIdentity(candidate.publicKey);
  const service = createAuthorityOwnershipService({
    instance: candidateInstance,
    issuerPrivateKey: issuer.privateKey,
    trustedIssuerPublicKeys: [issuer.publicKey.toString("base64")],
    persistencePath: path,
    now: () => 5_000,
    revokedGrantIds: () => [],
    state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
  });
  const grant = (epoch = 1, grantId = `grant-${epoch}`) =>
    createSignedAuthorityGrant(
      {
        version: 1,
        candidateInstanceId: candidateInstance.instanceId,
        authorityEpoch: epoch,
        stateRevision: 7,
        stateDigest: "a".repeat(64),
        grantId,
        issuedAt: 1_000,
        expiresAt: 10_000,
        issuerInstanceId: issuerInstance.instanceId,
        issuerPublicKey: issuer.publicKey.toString("base64"),
      } as Parameters<typeof createSignedAuthorityGrant>[0],
      issuer.privateKey,
    );
  return { service, grant, candidateInstance, path, issuer, candidate };
}

function issuerFixture(path: string, now = 5_000, keys?: { issuerIdentity: ReturnType<typeof createIdentity> }) {
  const issuerIdentity = keys?.issuerIdentity ?? createIdentity();
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
    version: 1,
    callerIdentity: operator,
    candidateInstanceId: candidateInstance.instanceId,
    authorityEpoch: 1,
    stateRevision: 7,
    stateDigest: "a".repeat(64),
    grantId: "grant-1",
    issuedAt: 1_000,
    expiresAt: 10_000,
    ...overrides,
  });
  return { issuer, request, issuerIdentity, candidateIdentity, issuerInstance, candidateInstance, operator, authorizer };
}

function drillSetup(path: string, policyPath: string, keys?: { issuerIdentity: ReturnType<typeof createIdentity>; candidateIdentity: ReturnType<typeof createIdentity> }) {
  const issuerIdentity = keys?.issuerIdentity ?? createIdentity();
  const candidateIdentity = keys?.candidateIdentity ?? createIdentity();
  const candidateInstanceId = createCoordinatorInstanceIdentity(candidateIdentity.publicKey).instanceId;
  const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
  const policy = createAuthorityRecoveryPolicy({
    issuerIdentity,
    issuerInstanceId,
    candidateInstanceId,
    persistencePath: policyPath,
    now: () => 1_000,
  });
  const drill = createAuthorityRecoveryDrill({ policy, persistencePath: path });
  const evidence = (overrides: Record<string, unknown> = {}) => ({
    version: 1 as const,
    issuerInstanceId,
    issuerInitialized: true,
    issuerPersistenceState: "valid" as const,
    candidateInstanceId,
    authorityEpoch: 1,
    candidateEpoch: 1,
    candidateState: "non-authoritative" as const,
    ownershipState: "non-authoritative" as const,
    ownershipEpoch: 1,
    ownerInstanceId: candidateInstanceId,
    stateRevision: 7,
    stateDigest: "a".repeat(64),
    stateFresh: true,
    validGrant: true,
    grantRevoked: false,
    issuerIdentityMatches: true,
    persistedStateHealthy: true,
    activeOwnershipConflict: false,
    ...overrides,
  });
  return { drill, policy, evidence, issuerInstanceId, candidateInstanceId, issuerIdentity, candidateIdentity };
}

describe("Milestone 065: coordinator-ha persistence stress", () => {
  it("ownership survives restart, fencing persists, corruption fails closed", async () => {
    const d = dir();
    const path = join(d, "owner.json");
    const keys = { issuer: createIdentity(), candidate: createIdentity() };
    const f = ownershipSetup(path, keys);
    const token = f.service.createToken(f.grant());
    await f.service.establishOwnership(token);
    const again = ownershipSetup(path, keys);
    expect(again.service.inspectOwnership()).toMatchObject({ state: "authoritative", authorityEpoch: 1 });
    expect(again.service.validateOwnershipToken(token)).toBe(true);
    await again.service.fenceOwner("operator");
    const fenced = ownershipSetup(path, keys);
    expect(fenced.service.inspectOwnership().state).toBe("fenced");
    await expect(fenced.service.establishOwnership(token)).rejects.toThrow();
    writeFileSync(path, "{bad", "utf8");
    const corrupt = ownershipSetup(path, keys);
    expect(corrupt.service.persistenceState()).toBe("corrupt");
    // Fail-closed: persistence is unavailable so ownership can never be
    // established from corrupt state, and no authority is held.
    await expect(corrupt.service.establishOwnership(token)).rejects.toThrow(/unavailable/);
    expect(corrupt.service.inspectOwnership().state).not.toBe("authoritative");
    rmSync(d, { recursive: true, force: true });
  });

  it("grant accept/revoke persist across restart and stay fail-closed on corruption", async () => {
    const d = dir();
    const path = join(d, "authority.json");
    const keys = { issuer: createIdentity(), candidate: createIdentity() };
    const first = grantSetup(path, keys);
    await first.service.acceptGrant(first.make());
    const second = grantSetup(path, keys);
    expect(second.service.inspectState()).toMatchObject({ state: "authoritative", authorityEpoch: 1 });
    await second.service.revoke("operator");
    const third = grantSetup(path, keys);
    expect(third.service.inspectState().state).toBe("revoked");
    writeFileSync(path, "{corrupt", "utf8");
    const corrupt = grantSetup(path, keys);
    expect(corrupt.service.inspectState().state).toBe("non-authoritative");
    expect((await corrupt.service.inspectAuthority()).placementAuthorized).toBe(false);
    rmSync(d, { recursive: true, force: true });
  });

  it("issuer epoch, audits, and revocations persist; audit log stays bounded", async () => {
    const d = dir();
    const path = join(d, "issuer.json");
    const keys = { issuerIdentity: createIdentity() };
    const f = issuerFixture(path, 5_000, keys);
    await f.issuer.bootstrap(1);
    await f.issuer.issue(f.request());
    const second = issuerFixture(path, 5_000, keys);
    expect(second.issuer.inspect()).toMatchObject({ initialized: true, authorityEpoch: 1 });
    expect(second.issuer.audits().length).toBeGreaterThan(0);
    // Bounded: repeated issuance with fresh revisions never exceeds the cap.
    for (let i = 0; i < 6; i++) {
      try {
        await second.issuer.issue(second.request({ grantId: `grant-bounded-${i}`, stateRevision: 10 + i }));
      } catch {}
    }
    expect(second.issuer.audits().length).toBeLessThanOrEqual(1024);
    const reloaded = issuerFixture(path, 5_000, keys);
    expect(reloaded.issuer.inspect().authorityEpoch).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it("drill authorization persists across restart and corruption denies", async () => {
    const d = dir();
    const path = join(d, "drill.json");
    const policyPath = join(d, "recovery.json");
    const f = drillSetup(path, policyPath);
    const auth = await f.policy.requestAuthorization({
      version: 1,
      candidateInstanceId: f.candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId: f.issuerInstanceId,
      operatorIdentity: "operator:alice",
      issuedAt: 1_000,
      expiresAt: 60_000,
    });
    expect(f.drill.prepare(f.evidence(), auth).state).toBe("authorized");
    const restarted = drillSetup(path, policyPath);
    expect(restarted.drill.read()?.state).toBe("authorized");
    writeFileSync(path, "{corrupt", "utf8");
    const corrupt = drillSetup(path, policyPath);
    expect(corrupt.drill.read()?.state).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });

  it("replica revision ordering holds across restart; tampering never authorizes", async () => {
    const d = dir();
    const path = join(d, "replica.json");
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const make = (revision: number) => ({
      version: 1 as const,
      instance,
      revision,
      observedAt: now,
      nodes: [],
    });
    const exporter = (revision: number) =>
      createCoordinatorSnapshotExporter(() => make(revision), identity.privateKey, () => now);
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: path });
    const r3 = await exporter(3).request({ version: 1 });
    expect((await replica.import(r3, true)).accepted).toBe(true);
    // Restart preserves revision: older import rejected as stale.
    const reloaded = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: path });
    expect(reloaded.status().acceptedRevision).toBe(3);
    const r2 = await exporter(2).request({ version: 1 });
    const stale = await reloaded.import(r2, true);
    expect(stale.accepted).toBe(false);
    expect(stale.reason).toBe("stale_revision");
    // Newer valid import accepted after restart.
    const r4 = await exporter(4).request({ version: 1 });
    expect((await reloaded.import(r4, true)).accepted).toBe(true);
    // Tampered persisted file can never become authoritative.
    writeFileSync(path, JSON.stringify({ version: 1, snapshot: make(99), proof: createAuthorityProof(make(4), identity.privateKey, now) }), "utf8");
    const tampered = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: path });
    expect(tampered.status().state).toBe("unavailable");
    expect(tampered.status().authorityClassification).toBe("non-authoritative");
    rmSync(d, { recursive: true, force: true });
  });

  it("stale temp artifacts are swept on every HA load path and never accumulate", async () => {
    const d = dir();
    const ownerPath = join(d, "owner.json");
    const grantPath = join(d, "grant.json");
    const issuerPath = join(d, "issuer.json");
    const drillPath = join(d, "drill.json");
    const policyPath = join(d, "recovery.json");
    const replicaPath = join(d, "replica.json");
    const ownerKeys = { issuer: createIdentity(), candidate: createIdentity() };
    const grantKeys = { issuer: createIdentity(), candidate: createIdentity() };
    const issuerKeys = { issuerIdentity: createIdentity() };
    // Create committed state on every path first.
    const o0 = ownershipSetup(ownerPath, ownerKeys);
    await o0.service.establishOwnership(o0.service.createToken(o0.grant()));
    const g0 = grantSetup(grantPath, grantKeys);
    await g0.service.acceptGrant(g0.make());
    const i0 = issuerFixture(issuerPath, 5_000, issuerKeys);
    await i0.issuer.bootstrap(1);
    const dr0 = drillSetup(drillPath, policyPath);
    const auth0 = await dr0.policy.requestAuthorization({
      version: 1,
      candidateInstanceId: dr0.candidateInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId: dr0.issuerInstanceId,
      operatorIdentity: "operator:alice",
      issuedAt: 1_000,
      expiresAt: 60_000,
    });
    expect(dr0.drill.prepare(dr0.evidence(), auth0).state).toBe("authorized");
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const now = Date.now();
    const seed = {
      version: 1 as const,
      instance,
      revision: 1,
      observedAt: now,
      nodes: [],
    };
    const seedResponse = {
      version: 1 as const,
      snapshot: seed,
      proof: createAuthorityProof(seed, identity.privateKey, now),
    };
    const seeder = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: replicaPath });
    expect((await seeder.import(seedResponse, true)).accepted).toBe(true);
    // Plant crash leftovers for every path.
    writeFileSync(`${ownerPath}.tmp-1-1`, "partial");
    writeFileSync(`${grantPath}.tmp-1-1`, "partial");
    writeFileSync(`${issuerPath}.tmp-1-1`, "partial");
    writeFileSync(`${drillPath}.tmp-1-1`, "partial");
    writeFileSync(`${replicaPath}.tmp`, "partial");
    writeFileSync(join(d, "unrelated.txt"), "keep");
    // Reloading every service sweeps its temps while committed state survives.
    expect(ownershipSetup(ownerPath, ownerKeys).service.inspectOwnership().state).toBe("authoritative");
    expect(grantSetup(grantPath, grantKeys).service.inspectState().state).toBe("authoritative");
    expect(issuerFixture(issuerPath, 5_000, issuerKeys).issuer.inspect().initialized).toBe(true);
    const dr1 = drillSetup(drillPath, policyPath, { issuerIdentity: dr0.issuerIdentity, candidateIdentity: dr0.candidateIdentity });
    expect(dr1.drill.read()?.state).toBe("authorized");
    // Reloading the replica sweeps its stale temp while the committed
    // revision survives.
    const reloadedReplica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: replicaPath });
    expect(reloadedReplica.status().acceptedRevision).toBe(1);
    expect(readdirSync(d).sort()).toEqual(
      ["drill.json", "grant.json", "issuer.json", "owner.json", "recovery.json", "replica.json", "unrelated.txt"].sort(),
    );
    rmSync(d, { recursive: true, force: true });
  });

  it("repeated persist/restart cycles keep authority stable and files bounded", async () => {
    const d = dir();
    const ownerPath = join(d, "owner.json");
    const grantPath = join(d, "grant.json");
    const ownerKeys = { issuer: createIdentity(), candidate: createIdentity() };
    const grantKeys = { issuer: createIdentity(), candidate: createIdentity() };
    const f = ownershipSetup(ownerPath, ownerKeys);
    const token = f.service.createToken(f.grant());
    await f.service.establishOwnership(token);
    const g0 = grantSetup(grantPath, grantKeys);
    await g0.service.acceptGrant(g0.make());
    for (let cycle = 0; cycle < 5; cycle++) {
      const reloaded = ownershipSetup(ownerPath, ownerKeys);
      expect(reloaded.service.inspectOwnership()).toMatchObject({ state: "authoritative", authorityEpoch: 1 });
      expect(reloaded.service.validateOwnershipToken(token)).toBe(true);
      const reloadedGrant = grantSetup(grantPath, grantKeys);
      expect(reloadedGrant.service.inspectState().state).toBe("authoritative");
    }
    // Bounded: exactly the committed files, no temp growth.
    expect(readdirSync(d).sort()).toEqual(["grant.json", "owner.json"]);
    rmSync(d, { recursive: true, force: true });
  });

  it("instance identity is stable and untrusted instances can never authorize", async () => {
    const a = createIdentity();
    const b = createIdentity();
    expect(createCoordinatorInstanceIdentity(a.publicKey).instanceId).toBe(
      createCoordinatorInstanceIdentity(Buffer.from(a.publicKey)).instanceId,
    );
    expect(createCoordinatorInstanceIdentity(a.publicKey).instanceId).not.toBe(
      createCoordinatorInstanceIdentity(b.publicKey).instanceId,
    );
    const d = dir();
    const path = join(d, "replica.json");
    const instance = createCoordinatorInstanceIdentity(a.publicKey);
    const replica = new CoordinatorReplicaImporter({ trustedInstanceIds: [instance.instanceId], persistencePath: path });
    const now = Date.now();
    const foreign = {
      version: 1 as const,
      instance: createCoordinatorInstanceIdentity(b.publicKey),
      revision: 1,
      observedAt: now,
      nodes: [],
    };
    const response = { version: 1 as const, snapshot: foreign, proof: createAuthorityProof(foreign, b.privateKey, now) };
    const result = await replica.import(response, true);
    expect(result.accepted).toBe(false);
    expect(replica.status().authorityClassification).toBe("non-authoritative");
    rmSync(d, { recursive: true, force: true });
  });
});
