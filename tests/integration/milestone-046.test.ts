import { describe, expect, it } from "vitest";
import { rm } from "fs/promises";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry, createSignedHeartbeat, createSignedRegistration } from "../../packages/registry/index.js";
import { createRegistryCoordinator, createRegistryClient } from "../../packages/registry/coordinator.js";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { createStorageNode } from "../../apps/storage-node/index.js";

describe("Milestone 046 coordinator and lifecycle status", () => {
  it("reports aggregate health and expires records through the coordinator worker", async () => {
    const identity = createIdentity();
    const lifecycle: string[] = [];
    const registry = createRegistry({ heartbeatTimeoutMs: 50, onLifecycleEvent: (event) => { if ("nodeId" in event) lifecycle.push(event.type); } });
    const coordinator = createRegistryCoordinator({
      registry,
      expiryIntervalMs: 5,
      startExpiryWorker: true,
    });
    const port = await coordinator.listen(0);
    try {
      registry.registerSigned(createSignedRegistration(identity, "http://127.0.0.1:9999", {
        capacity: { allocatedBytes: 100, usedBytes: 10, availableBytes: 90 },
      }));
      registry.registerSigned(createSignedRegistration(identity, "http://127.0.0.1:9999", {
        capacity: { allocatedBytes: 100, usedBytes: 10, availableBytes: 90 },
      }));
      registry.heartbeatSigned(createSignedHeartbeat(identity, identity.publicKey.toString("base64")));
      const client = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}` });
      const status = await client.status();
      expect(status.aggregate).toMatchObject({ totalNodes: 1, availableNodes: 1, totalCapacityBytes: 100 });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect((await client.status()).aggregate.unavailableNodes).toBe(1);
      expect(lifecycle).toContain("node.registered");
      expect(lifecycle).toContain("node.re-registered");
      expect(lifecycle).toContain("node.heartbeat-accepted");
      expect(lifecycle).toContain("node.expired");
    } finally {
      await coordinator.close();
    }
  });

  it("preserves coordinator last-known-good metadata after refresh failure", async () => {
    let available = true;
    const adapter = createCoordinatorAdapter({
      baseUrl: "http://coordinator.invalid",
      fetch: async () => {
        if (!available) throw new Error("offline");
        return new Response(JSON.stringify({ nodes: [{
          nodeId: "node-a", publicKey: Buffer.alloc(44).toString("base64"), baseUrl: "http://127.0.0.1:1",
          available: true, capacity: { allocatedBytes: 1, usedBytes: 0, availableBytes: 1 }, reliability: { score: 50, storageScore: 50 },
        }] }), { status: 200 });
      },
    });
    await adapter.refresh();
    available = false;
    await expect(adapter.refresh()).rejects.toThrow("offline");
    expect(adapter.getEndpoints()).toHaveLength(1);
    expect(adapter.metadata.lastKnownGoodCount).toBe(1);
    expect(adapter.metadata.lastError).toContain("offline");
    expect(adapter.metadata.lastErrorClassification).toBe("unknown");
    expect(adapter.metadata.consecutiveFailureCount).toBe(1);
    expect(adapter.metadata.isStale).toBe(true);
    expect(adapter.metadata.snapshotAge).toBeGreaterThanOrEqual(0);
  });

  it("provides a read-only storage status snapshot and sanitized lifecycle events", async () => {
    const events: string[] = [];
    const node = createStorageNode({
      storageDir: "milestone-046-status-test",
      onLifecycleEvent: (event) => events.push(event.type),
    });
    try {
      await node.listen(0);
      expect((await node.getStatusSnapshot()).status).toBe("ok");
      node.setDraining(true);
      expect((await node.getStatusSnapshot()).status).toBe("draining");
      expect(events).toContain("storage-node.draining");
    } finally {
      await node.close();
      await rm("milestone-046-status-test", { recursive: true, force: true });
    }
  });
});
