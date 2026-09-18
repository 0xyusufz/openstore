import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "../coordinator-ha/index.js";
import { createAuthorityIssuer } from "../coordinator-ha/authority-issuer.js";
import { createAuthorityGrantService } from "../coordinator-ha/authority-grant.js";
import { createAuthorityOwnershipService } from "../coordinator-ha/authority-ownership.js";
import { createAuthorityRecoveryPolicy } from "../coordinator-ha/authority-recovery-policy.js";
import { createAuthorityControlPlane } from "../coordinator-ha/authority-control-plane.js";
import { createCoordinatorAuthorityRuntime } from "../coordinator-ha/runtime.js";
import { createRegistry, type Registry } from "./index.js";
import { createRegistryCoordinator } from "./coordinator.js";

async function createRecoveryServer(options: { token?: string; maxBodyBytes?: number; candidateIdentity?: ReturnType<typeof createIdentity>; issuerIdentity?: ReturnType<typeof createIdentity>; candidateOverride?: string; issuerOverride?: string; useOwnedState?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "openstore-055-http-"));
  const issuerIdentity = options.issuerIdentity ?? createIdentity();
  const candidateIdentity = options.candidateIdentity ?? createIdentity();
  const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
  const candidateInstanceId = createCoordinatorInstanceIdentity(candidateIdentity.publicKey).instanceId;
  const authorizer = { authenticate: (value: string) => value === "operator:055-http", mayIssue: (value: string) => value === "operator:055-http" };
  const issuer = createAuthorityIssuer({ identity: issuerIdentity, persistencePath: join(dir, "issuer.json"), authorizer, now: () => Date.now() });
  const candidate = createAuthorityGrantService({
    instance: createCoordinatorInstanceIdentity(candidateIdentity.publicKey),
    trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
    persistencePath: join(dir, `candidate-${candidateInstanceId}.json`),
    state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    revokedGrantIds: () => [],
  });
  const ownership = createAuthorityOwnershipService({
    instance: createCoordinatorInstanceIdentity(candidateIdentity.publicKey),
    issuerPrivateKey: issuerIdentity.privateKey,
    trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
    persistencePath: join(dir, "ownership.json"),
    state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
    revokedGrantIds: () => [],
  });
  const policy = createAuthorityRecoveryPolicy({
    issuerIdentity,
    issuerInstanceId: issuerInstanceId,
    candidateInstanceId: candidateInstanceId,
    persistencePath: join(dir, "recovery-policy.json"),
    now: () => Date.now(),
  });
  const controlPlane = createAuthorityControlPlane({
    issuer,
    candidate,
    ownership,
    candidateInstanceId: candidateInstanceId,
    issuerInstanceId: issuerInstanceId,
    revokedGrantIds: () => [],
    recoveryPolicy: policy,
    issuerIdentity,
    recoveryPersistencePath: join(dir, "recovery-policy.json"),
  });
  const runtime = createCoordinatorAuthorityRuntime({
    controlPlane,
    issuer,
    candidate,
    ownership,
    issuerInstanceId: issuerInstanceId,
    recoveryPolicy: policy,
    now: () => Date.now(),
  });
  await issuer.bootstrap(1);
  await runtime.start();
  const grant = await controlPlane.issueGrant({
    operation: "request-grant",
    version: 1,
    callerIdentity: "operator:055-http",
    candidateInstanceId: candidateInstanceId,
    authorityEpoch: 1,
    stateRevision: 7,
    stateDigest: "a".repeat(64),
    grantId: "grant-055-http",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  await controlPlane.deliverGrant(grant);
  await controlPlane.acceptGrant(grant.grantId);
  await runtime.establishOwnership();
  const evidence = {
    version: 1,
    issuerInstanceId: issuerInstanceId,
    issuerInitialized: true,
    issuerPersistenceState: "valid",
    candidateInstanceId: candidateInstanceId,
    authorityEpoch: 1,
    candidateEpoch: 1,
    candidateState: "authoritative",
    ownershipState: "authoritative",
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
  };
  const authorization = await controlPlane.requestRecoveryAuthorization({
    version: 1,
    candidateInstanceId: candidateInstanceId,
    authorityEpoch: 1,
    stateRevision: 7,
    stateDigest: "a".repeat(64),
    issuerInstanceId: issuerInstanceId,
    operatorIdentity: "operator:055-http",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  const coordinator = createRegistryCoordinator({
    registry: createRegistry() as Registry,
    token: options.token ?? "secret",
    authorityControlPlane: controlPlane,
    authorityRuntime: runtime,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
  });
  const port = await coordinator.listen(0);
  return {
    dir,
    coordinator,
    baseUrl: `http://127.0.0.1:${port}`,
    token: options.token ?? "secret",
    evidence,
    authorization,
    issuerIdentity,
    candidateIdentity,
    candidateInstanceId,
    issuerInstanceId,
    runtime,
    controlPlane,
  };
}

async function httpJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

describe("coordinator recovery HTTP routes", () => {
  it("rejects unauthenticated inspect", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await fetch(`${server.baseUrl}/v1/recovery/inspect?evidence=${encodeURIComponent(JSON.stringify(server.evidence))}`);
      expect(response.status).toBe(401);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("accepts authenticated inspect", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/inspect?evidence=${encodeURIComponent(JSON.stringify(server.evidence))}`, { headers: { authorization: `Bearer ${server.token}` } });
      expect(response.status).toBe(200);
      expect(response.body.state).toBe("authorization-required");
      expect(response.body.decision).toBe("requires_operator_authorization");
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated diagnose", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await fetch(`${server.baseUrl}/v1/recovery/diagnose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ evidence: server.evidence }) });
      expect(response.status).toBe(401);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("accepts authenticated diagnose", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/diagnose`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence }),
      });
      expect(response.status).toBe(200);
      expect(response.body.state).toBe("authorization-required");
      expect(response.body.authorizationRequired).toBe(true);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects prepare without valid authorization", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence }),
      });
      expect(response.status).toBe(403);
      expect(response.body.state).toBe("authorization-required");
      expect(response.body.reason).toBe("operator_authorization_required");
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed authorization payload", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, authorization: { candidateInstanceId: "bad" } }),
      });
      expect(response.status).toBe(422);
      expect(response.body.state).toBe("rejected");
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("accepts a valid authorization in prepare", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, authorization: server.authorization }),
      });
      expect(response.status).toBe(200);
      expect(response.body.state).toBe("authorized");
      expect(response.body.authorized).toBe(true);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects execute before authorization", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/execute`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, action: "approve" }),
      });
      expect(response.status).toBe(403);
      expect(response.body.state).toBe("authorization-required");
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("executes the real recovery path after valid authorization", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/execute`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, action: "approve", authorization: server.authorization }),
      });
      expect(response.status).toBe(200);
      expect(response.body.state).toBe("recovered");
      expect(response.body.decision).toBe("allowed");
      expect(response.body.executed).toBe(true);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("verifies after execution succeeds", async () => {
    const server = await createRecoveryServer();
    try {
      const execute = await httpJson(`${server.baseUrl}/v1/recovery/execute`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, action: "approve", authorization: server.authorization }),
      });
      expect(execute.status).toBe(200);
      const verify = await httpJson(`${server.baseUrl}/v1/recovery/verify`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, authorization: server.authorization }),
      });
      expect(verify.status).toBe(200);
      expect(verify.body.state).toBe("recovered");
      expect(verify.body.verified).toBe(true);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects verify before execution", async () => {
    const server = await createRecoveryServer();
    try {
      const verify = await httpJson(`${server.baseUrl}/v1/recovery/verify`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, authorization: server.authorization }),
      });
      expect(verify.status).toBe(422);
      expect(verify.body.state).toBe("rejected");
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects expired authorization", async () => {
    const server = await createRecoveryServer();
    try {
      const expired = await server.controlPlane.requestRecoveryAuthorization({
        version: 1,
        candidateInstanceId: server.candidateInstanceId,
        authorityEpoch: 1,
        stateRevision: 7,
        stateDigest: "a".repeat(64),
        issuerInstanceId: server.issuerInstanceId,
        operatorIdentity: "operator:expired",
        issuedAt: Date.now() - 60_000,
        expiresAt: Date.now() - 1,
      });
      const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, authorization: expired }),
      });
      expect(response.status).toBe(422);
      expect(response.body.reason).toMatch(/authorization_expired|expired/i);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects revoked authorization", async () => {
    const server = await createRecoveryServer();
    try {
      const revoked = await server.controlPlane.requestRecoveryAuthorization({
        version: 1,
        candidateInstanceId: server.candidateInstanceId,
        authorityEpoch: 1,
        stateRevision: 7,
        stateDigest: "a".repeat(64),
        issuerInstanceId: server.issuerInstanceId,
        operatorIdentity: "operator:revoked",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
      await server.controlPlane.rejectRecoveryAuthorization(revoked.authorizationId, "revoked-by-test");
      const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, authorization: revoked }),
      });
      expect(response.status).toBe(422);
      expect(response.body.reason).toMatch(/authorization_revoked|revoked/i);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects replayed authorization and prevents duplicate mutation", async () => {
    const server = await createRecoveryServer();
    try {
      const first = await httpJson(`${server.baseUrl}/v1/recovery/execute`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, action: "approve", authorization: server.authorization }),
      });
      expect(first.status).toBe(200);
      const second = await httpJson(`${server.baseUrl}/v1/recovery/execute`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, action: "approve", authorization: server.authorization }),
      });
      expect(second.status).toBe(422);
      expect(second.body.state).toBe("rejected");
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects ownership conflict", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          evidence: { ...server.evidence, activeOwnershipConflict: true, ownershipState: "fenced" },
          authorization: server.authorization,
        }),
      });
      expect(response.status).toBe(503);
      expect(response.body.state).toBe("conflicted");
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects wrong epoch, wrong revision, and wrong digest", async () => {
    const server = await createRecoveryServer();
    try {
      const wrongEpoch = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: { ...server.evidence, authorityEpoch: 2 }, authorization: server.authorization }),
      });
      expect(wrongEpoch.status).toBe(422);

      const wrongRevision = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: { ...server.evidence, stateRevision: 99 }, authorization: server.authorization }),
      });
      expect(wrongRevision.status).toBe(422);

      const wrongDigest = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: { ...server.evidence, stateDigest: "b".repeat(64) }, authorization: server.authorization }),
      });
      expect(wrongDigest.status).toBe(422);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON and oversized request bodies", async () => {
    const server = await createRecoveryServer({ maxBodyBytes: 64 });
    try {
      const malformed = await fetch(`${server.baseUrl}/v1/recovery/diagnose`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: "{not valid",
      });
      expect(malformed.status).toBe(400);
      const oversized = await fetch(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, authorization: server.authorization, payload: "x".repeat(1024*1024) }),
      });
      expect(oversized.status).toBe(400);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("sanitizes responses and strips secrets", async () => {
    const server = await createRecoveryServer();
    try {
      const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({ evidence: server.evidence, authorization: server.authorization }),
      });
      const serialized = JSON.stringify(response.body);
      expect(response.status).toBe(200);
      expect(serialized).not.toMatch(/private key|recovery phrase|recoveryPhrase|decryption key|dek|ownership token|signature|authorization credentials|persist|secret/i);
      expect(serialized).not.toContain(server.authorization.signature);
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("rejects a valid authorization when the candidate binding is wrong", async () => {
    const server = await createRecoveryServer();
    try {
      const otherCandidate = createIdentity();
      const otherCandidateId = createCoordinatorInstanceIdentity(otherCandidate.publicKey).instanceId;
      const response = await httpJson(`${server.baseUrl}/v1/recovery/prepare`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          evidence: { ...server.evidence, candidateInstanceId: otherCandidateId },
          authorization: server.authorization,
        }),
      });
      expect(response.status).toBe(422);
      expect(response.body.state).toBe("rejected");
    } finally {
      await server.coordinator.close();
      rmSync(server.dir, { recursive: true, force: true });
    }
  });

  it("does not auto-resume recovery mutation after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-055-restart-"));
    const issuerIdentity = createIdentity();
    const candidateIdentity = createIdentity();
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuerIdentity.publicKey).instanceId;
    const candidateInstanceId = createCoordinatorInstanceIdentity(candidateIdentity.publicKey).instanceId;
    const authorizer = { authenticate: (value: string) => value === "operator:055-http", mayIssue: (value: string) => value === "operator:055-http" };
    const issuer = createAuthorityIssuer({ identity: issuerIdentity, persistencePath: join(dir, "issuer.json"), authorizer, now: () => Date.now() });
    const candidate = createAuthorityGrantService({
      instance: createCoordinatorInstanceIdentity(candidateIdentity.publicKey),
      trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
      persistencePath: join(dir, `candidate-${candidateInstanceId}.json`),
      state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
      revokedGrantIds: () => [],
    });
    const ownership = createAuthorityOwnershipService({
      instance: createCoordinatorInstanceIdentity(candidateIdentity.publicKey),
      issuerPrivateKey: issuerIdentity.privateKey,
      trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
      persistencePath: join(dir, "ownership.json"),
      state: () => ({ revision: 7, digest: "a".repeat(64), fresh: true }),
      revokedGrantIds: () => [],
    });
    const policy = createAuthorityRecoveryPolicy({ issuerIdentity, issuerInstanceId, candidateInstanceId, persistencePath: join(dir, "recovery-policy.json"), now: () => Date.now() });
    const control = createAuthorityControlPlane({ issuer, candidate, ownership, candidateInstanceId, issuerInstanceId, revokedGrantIds: () => [], recoveryPolicy: policy, issuerIdentity, recoveryPersistencePath: join(dir, "recovery-policy.json") });
    const runtime = createCoordinatorAuthorityRuntime({ controlPlane: control, issuer, candidate, ownership, issuerInstanceId, recoveryPolicy: policy, now: () => Date.now() });
    await issuer.bootstrap(1);
    await runtime.start();
    const grant = await control.issueGrant({ operation: "request-grant", version: 1, callerIdentity: "operator:055-http", candidateInstanceId, authorityEpoch: 1, stateRevision: 7, stateDigest: "a".repeat(64), grantId: "grant-restart-055", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    await control.deliverGrant(grant); await control.acceptGrant(grant.grantId); await runtime.establishOwnership();
    const auth = await control.requestRecoveryAuthorization({ version: 1, candidateInstanceId, authorityEpoch: 1, stateRevision: 7, stateDigest: "a".repeat(64), issuerInstanceId, operatorIdentity: "operator:055-http", issuedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    const evidence = {
      version: 1,
      issuerInstanceId,
      issuerInitialized: true,
      issuerPersistenceState: "valid",
      candidateInstanceId,
      authorityEpoch: 1,
      candidateEpoch: 1,
      candidateState: "authoritative",
      ownershipState: "authoritative",
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
    };
    const first = createRegistryCoordinator({ registry: createRegistry(), token: "secret", authorityControlPlane: control, authorityRuntime: runtime, maxBodyBytes: 1024 * 1024 });
    const port = await first.listen(0);
    try {
      const execute = await httpJson(`http://127.0.0.1:${port}/v1/recovery/execute`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ evidence, action: "approve", authorization: auth }),
      });
      expect(execute.status).toBe(200);
      await first.close();
      const restarted = createRegistryCoordinator({ registry: createRegistry(), token: "secret", authorityControlPlane: control, authorityRuntime: runtime, maxBodyBytes: 1024 * 1024 });
      const port2 = await restarted.listen(0);
      try {
        const inspect = await httpJson(`http://127.0.0.1:${port2}/v1/recovery/inspect?evidence=${encodeURIComponent(JSON.stringify(evidence))}`, { headers: { authorization: "Bearer secret" } });
        expect(inspect.status).toBe(200);
        expect(inspect.body.state).not.toBe("recovered");
      } finally { await restarted.close(); }
    } finally {
      await first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
