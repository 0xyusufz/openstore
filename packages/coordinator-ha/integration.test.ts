import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createRegistry } from "../registry/index.js";
import { createCoordinatorInstanceIdentity, createCoordinatorSnapshotExporter } from "./index.js";
import { createCoordinatorHaAdapter, parseCoordinatorHaConfig } from "./integration.js";

describe("coordinator HA integration boundary", () => {
  it("defaults to standalone and validates observer configuration", () => {
    expect(parseCoordinatorHaConfig({} as NodeJS.ProcessEnv)).toMatchObject({
      enabled: false, role: "standalone",
    });
    expect(() => parseCoordinatorHaConfig({
      OPENSTORE_COORDINATOR_HA_ENABLED: "true",
      OPENSTORE_COORDINATOR_HA_ROLE: "replica-observer",
    } as NodeJS.ProcessEnv)).toThrow();
    expect(() => parseCoordinatorHaConfig({
      OPENSTORE_COORDINATOR_HA_ROLE: "leader",
    } as NodeJS.ProcessEnv)).toThrow();
  });

  it("keeps the authoritative registry as source of truth and observer non-authoritative", async () => {
    const sourceIdentity = createIdentity();
    const sourceInstance = createCoordinatorInstanceIdentity(sourceIdentity.publicKey);
    const sourceRegistry = createRegistry();
    const source = createCoordinatorHaAdapter({
      config: { enabled: false, role: "standalone", syncIntervalMs: 5_000, staleAfterMs: 30_000 },
      registry: sourceRegistry,
      instance: sourceInstance,
      signingKey: sourceIdentity.privateKey,
      revision: () => 1,
    });
    const response = await source.exportState();
    const replica = createCoordinatorHaAdapter({
      config: { enabled: true, role: "replica-observer", trustedInstanceId: sourceInstance.instanceId, syncIntervalMs: 5_000, staleAfterMs: 30_000 },
      registry: createRegistry(),
      instance: createCoordinatorInstanceIdentity(createIdentity().publicKey),
      source: { request: async () => response },
    });
    await replica.start();
    expect(replica.status()).toMatchObject({ state: "synchronized", authorityClassification: "non-authoritative", acceptedRevision: 1 });
    await replica.forceSync();
    expect(replica.status()).toMatchObject({ authorityClassification: "non-authoritative" });
    replica.stop();
  });

  it("exports bounded state without duplicating registry ownership", async () => {
    const identity = createIdentity();
    const instance = createCoordinatorInstanceIdentity(identity.publicKey);
    const registry = createRegistry();
    const adapter = createCoordinatorHaAdapter({
      config: { enabled: false, role: "standalone", syncIntervalMs: 5_000, staleAfterMs: 30_000 },
      registry, instance, signingKey: identity.privateKey,
    });
    const response = await adapter.exportState({ version: 1, maxNodes: 1, maxBytes: 4096 });
    expect(response.snapshot.nodes).toHaveLength(0);
    expect(adapter.status()).toMatchObject({ state: "uninitialized", authorityClassification: "non-authoritative" });
  });

  it("awaits authority runtime shutdown", async () => {
    let stopped = false;
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
    const runtime = {
      start: async () => {},
      stop: async () => { await stopPromise; stopped = true; },
      status: () => ({ state: "stopped" as const, authority: { eligible: false, state: "unknown" as const, placementAuthorized: false, existingManifestOperationsAllowed: false, snapshotExportAllowed: false, snapshotImportAllowed: false }, issuerInstanceId: "coord-00000000000000000000000000000000", issuerPersistenceHealthy: true, candidatePersistenceHealthy: true, ownershipPersistenceHealthy: true, candidateState: { version: 1 as const, instanceId: "coord-00000000000000000000000000000000", state: "non-authoritative" as const, authorityEpoch: 0 }, ownership: { version: 1 as const, state: "non-authoritative" as const, authorityEpoch: 0, conflict: false }, lastTransition: "none" as const, conditions: [] }),
      validateOwnershipToken: () => false,
      establishOwnership: async () => {},
      releaseOwnership: async () => {},
      fenceOwner: async () => {},
      inspectRecovery: () => ({ decision: "denied" as const, state: "missing-evidence" as const, reason: "missing_evidence" as const, requiresOperatorAuthorization: false, authorized: false }),
      inspectRecoveryDrill: () => ({ state: "idle" as const, reason: "healthy" as const, decision: "denied" as const, recoveryState: "missing-evidence" as const, recoveryReason: "missing_evidence" as const, authorizationRequired: false, authorized: false, executed: false, verified: false }),
      diagnoseRecoveryDrill: () => ({ version: 1 as const, state: "idle" as const, reason: "healthy" as const, decision: "denied" as const, recoveryState: "missing-evidence" as const, recoveryReason: "missing_evidence" as const, observedAt: Date.now(), persistenceState: "missing" as const, persisted: false, ownershipConflict: false, authorizationRequired: false, lastTransition: "idle" as const }),
    };
    const identity = createIdentity();
    const adapter = createCoordinatorHaAdapter({
      config: { enabled: false, role: "standalone", syncIntervalMs: 5_000, staleAfterMs: 30_000 },
      registry: createRegistry(), instance: createCoordinatorInstanceIdentity(identity.publicKey),
      signingKey: identity.privateKey, authorityRuntime: runtime,
    });
    const stopping = adapter.stop();
    expect(stopped).toBe(false);
    resolveStop();
    await stopping;
    expect(stopped).toBe(true);
  });
});
