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
});

async function waitForNode(client: ReturnType<typeof createRegistryClient>, nodeId: string, lifecycle: "sharing" | "draining" | "released") {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const node = (await client.nodes()).find((candidate) => candidate.nodeId === nodeId);
    if (node && node.lifecycle === lifecycle) return node;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`node did not reach lifecycle ${lifecycle}`);
}
