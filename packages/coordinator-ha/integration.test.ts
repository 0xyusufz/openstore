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
});
