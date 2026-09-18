import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { createRegistry } from "../../packages/registry/index.js";
import { createRegistryClient, createRegistryCoordinator } from "../../packages/registry/coordinator.js";
import { selectNodes } from "../../apps/client/selection.js";
import { Libp2pPieceTransport } from "../../packages/p2p/libp2p.js";
import { createLibp2pStorageNodeRuntime } from "./libp2p-runtime.js";
import { coordinatorNodesToEndpoints } from "../../apps/client/coordinator.js";

describe("059B provider lifecycle coordinator propagation", () => {
  it("rejects unknown lifecycle metadata", () => {
    expect(() => coordinatorNodesToEndpoints({
      nodes: [{
        nodeId: "node", publicKey: Buffer.alloc(44).toString("base64"), baseUrl: "http://127.0.0.1:1",
        available: true, lifecycle: "paused", capacity: { allocatedBytes: 10, usedBytes: 0, availableBytes: 10 },
        reliability: { successfulHeartbeats: 0, missedHeartbeats: 0, score: 50, successfulAudits: 0, failedAudits: 0, storageScore: 50 },
      }],
    })).toThrow(/lifecycle/i);
  });

  it("heartbeat propagates draining and excludes the node while reads continue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-059b-"));
    const identity = createIdentity();
    const keystore = join(dir, "identity.json");
    await saveIdentity(identity, "test-password", keystore);
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "059b-token" });
    const port = await coordinator.listen(0);
    const client = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "059b-token" });
    const runtime = await createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"), allocationPath: join(dir, "allocation.json"), lifecyclePath: join(dir, "lifecycle.json"),
      capacityBytes: 4096, identityPath: keystore, identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"], coordinatorUrl: `http://127.0.0.1:${port}`, coordinatorToken: "059b-token",
      coordinatorHeartbeatIntervalMs: 100,
    });
    const transport = new Libp2pPieceTransport();
    try {
      await runtime.start();
      const sharing = await waitForNode(client, runtime.node.peerId, "sharing");
      expect(selectNodes([sharing], 1, 1)).toHaveLength(1);
      const endpoint = { nodeId: runtime.node.peerId, baseUrl: `libp2p://${runtime.node.peerId}`, multiaddr: runtime.node.listenAddrs[0], identityBinding: runtime.node.peerId, identity: runtime.node.applicationIdentity };
      expect((await transport.storePiece(endpoint, "existing", Buffer.from("opaque"), { timeoutMs: 5_000 })).status).toBe(201);
      expect(runtime.stopSharing?.().state).toBe("draining");
      const draining = await waitForNode(client, runtime.node.peerId, "draining");
      expect(() => selectNodes([draining], 1, 1)).toThrow(/insufficient/i);
      expect((await transport.getPiece(endpoint, "existing", { timeoutMs: 5_000 })).bytes?.toString()).toBe("opaque");
      expect(JSON.stringify(draining)).not.toMatch(/secret|password|private|plaintext|dek|token/i);
      expect((await transport.deletePiece(endpoint, "existing", { timeoutMs: 5_000 })).status).toBe(204);
      expect((await runtime.releaseAllocation?.())?.state).toBe("released");
      const released = await waitForNode(client, runtime.node.peerId, "released");
      expect(released.available).toBe(false);
      expect(() => selectNodes([released], 1, 1)).toThrow(/insufficient/i);
    } finally {
      await runtime.stop();
      await coordinator.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("resumes only after durable capacity revalidation and persists sharing across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-060a-resume-"));
    const identity = createIdentity();
    const keystore = join(dir, "identity.json");
    const storageDir = join(dir, "pieces");
    await saveIdentity(identity, "test-password", keystore);
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "060a-token" });
    const port = await coordinator.listen(0);
    const config = {
      storageDir, allocationPath: join(storageDir, "allocation.json"), lifecyclePath: join(storageDir, "lifecycle.json"),
      capacityBytes: 4096, identityPath: keystore, identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"], coordinatorUrl: `http://127.0.0.1:${port}`,
      coordinatorToken: "060a-token", coordinatorHeartbeatIntervalMs: 100,
    };
    const first = await createLibp2pStorageNodeRuntime(config);
    try {
      await first.start();
      expect(first.stopSharing?.().state).toBe("draining");
      expect((await waitForNode(clientFor(port), first.node.peerId, "draining")).lifecycle).toBe("draining");
      expect(first.resumeSharing?.().state).toBe("sharing");
      expect((await waitForNode(clientFor(port), first.node.peerId, "sharing")).lifecycle).toBe("sharing");
      expect((await first.statusSnapshot()).lifecycle?.state).toBe("sharing");
      await first.stop();
    } finally {
      if (first.state !== "stopped") await first.stop();
    }
    const restarted = await createLibp2pStorageNodeRuntime({ ...config, capacityBytes: undefined });
    try {
      expect((await restarted.statusSnapshot()).lifecycle?.state).toBe("sharing");
      await restarted.start();
      expect((await waitForNode(clientFor(port), restarted.node.peerId, "sharing")).lifecycle).toBe("sharing");
      expect(() => restarted.resumeSharing?.()).toThrow(/transition/i);
    } finally {
      await restarted.stop();
      await coordinator.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps released state after runtime restart and rejects resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-060a-released-"));
    const keystore = join(dir, "identity.json");
    const storageDir = join(dir, "pieces");
    await saveIdentity(createIdentity(), "test-password", keystore);
    const config = {
      storageDir, allocationPath: join(storageDir, "allocation.json"), lifecyclePath: join(storageDir, "lifecycle.json"),
      capacityBytes: 4096, identityPath: keystore, identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
    };
    const first = await createLibp2pStorageNodeRuntime(config);
    expect(first.stopSharing?.().state).toBe("draining");
    expect((await first.releaseAllocation?.())?.state).toBe("released");
    await first.stop();
    const restarted = await createLibp2pStorageNodeRuntime({ ...config, capacityBytes: undefined });
    try {
      expect((await restarted.statusSnapshot()).lifecycle?.state).toBe("released");
      expect(() => restarted.resumeSharing?.()).toThrow(/released|transition/i);
      await restarted.start();
      expect((await restarted.statusSnapshot()).lifecycle?.state).toBe("released");
    } finally {
      await restarted.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("propagates safe reallocation through heartbeat and keeps draining excluded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-060b-reallocation-"));
    const keystore = join(dir, "identity.json");
    const storageDir = join(dir, "pieces");
    await saveIdentity(createIdentity(), "test-password", keystore);
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "060b-token" });
    const port = await coordinator.listen(0);
    const config = {
      storageDir, allocationPath: join(storageDir, "allocation.json"), lifecyclePath: join(storageDir, "lifecycle.json"),
      capacityBytes: 4096, identityPath: keystore, identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"], coordinatorUrl: `http://127.0.0.1:${port}`,
      coordinatorToken: "060b-token", coordinatorHeartbeatIntervalMs: 100,
    };
    const runtime = await createLibp2pStorageNodeRuntime(config);
    const client = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "060b-token" });
    try {
      await runtime.start();
      const initial = await waitForNode(client, runtime.node.peerId, "sharing");
      expect(initial.capacity.allocatedBytes).toBe(4096);
      expect(() => selectNodes([initial], 5000, 1)).toThrow(/insufficient/i);
      expect(runtime.increaseAllocation?.(8192).allocationBytes).toBe(8192);
      const increased = await waitForCapacity(client, runtime.node.peerId, 8192);
      expect(increased.capacity.availableBytes).toBeGreaterThanOrEqual(8192);
      expect(selectNodes([increased], 5000, 1)).toHaveLength(1);
      expect(runtime.decreaseAllocation?.(7000).allocationBytes).toBe(7000);
      const decreased = await waitForCapacity(client, runtime.node.peerId, 7000);
      expect(decreased.capacity.allocatedBytes).toBe(7000);
      expect(runtime.stopSharing?.().state).toBe("draining");
      expect(runtime.increaseAllocation?.(7500).allocationBytes).toBe(7500);
      const draining = await waitForNode(client, runtime.node.peerId, "draining");
      expect(draining.capacity.allocatedBytes).toBe(7500);
      expect(() => selectNodes([draining], 1, 1)).toThrow(/insufficient/i);
      expect(runtime.releaseAllocation).toBeDefined();
      expect((await runtime.releaseAllocation?.())?.state).toBe("released");
      expect(() => runtime.increaseAllocation?.(8000)).toThrow(/released|resized/i);
      await runtime.stop();
      const restarted = await createLibp2pStorageNodeRuntime({ ...config, capacityBytes: undefined });
      try {
        expect((await restarted.statusSnapshot()).capacity.allocatedBytes).toBe(7500);
        expect((await restarted.statusSnapshot()).lifecycle?.state).toBe("released");
      } finally { await restarted.stop(); }
    } finally {
      if (runtime.state !== "stopped") await runtime.stop();
      await coordinator.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

function clientFor(port: number) {
  return createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "060a-token" });
}

async function waitForNode(client: ReturnType<typeof createRegistryClient>, nodeId: string, lifecycle: "sharing" | "draining" | "released") {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const node = (await client.nodes()).find((candidate) => candidate.nodeId === nodeId);
    if (node && node.lifecycle === lifecycle) return node;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`node did not reach lifecycle ${lifecycle}`);
}

async function waitForCapacity(client: ReturnType<typeof createRegistryClient>, nodeId: string, allocatedBytes: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const node = (await client.nodes()).find((candidate) => candidate.nodeId === nodeId);
    if (node?.capacity.allocatedBytes === allocatedBytes) return node;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`node did not report allocation ${allocatedBytes}`);
}
