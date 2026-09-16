import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createRegistry } from "./index.js";
import { createRegistryClient, createRegistryCoordinator } from "./coordinator.js";
import { peerIdFromOpenStorePublicKey } from "../p2p/identity-binding.js";

describe("cross-process registry coordinator", () => {
  it("registers, heartbeats, lists and removes nodes over HTTP", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    const client = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "secret" });
    const identity = createIdentity();
    const node = await client.registerWithIdentity(identity, "http://127.0.0.1:4901");
    expect(node.nodeId).toBe(identity.publicKey.toString("base64"));
    expect((await client.nodes())).toHaveLength(1);
    expect((await client.heartbeatWithIdentity(identity, node.nodeId)).available).toBe(true);
    await client.unregisterWithIdentity(identity, node.nodeId);
    expect(await client.nodes()).toHaveLength(0);
    await coordinator.close();
  });

  it("does not allow an untrusted process to use the coordinator", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/v1/nodes`);
    expect(response.status).toBe(401);
    await coordinator.close();
  });

  it("authenticates libp2p descriptor registration and preserves placement metadata", async () => {
    const coordinator = createRegistryCoordinator({ registry: createRegistry(), token: "secret" });
    const port = await coordinator.listen(0);
    const client = createRegistryClient({ baseUrl: `http://127.0.0.1:${port}`, token: "secret" });
    const identity = createIdentity();
    const peerId = peerIdFromOpenStorePublicKey(identity.publicKey);
    const descriptor = {
      nodeId: peerId, baseUrl: `libp2p://${peerId}`,
      multiaddr: `/ip4/127.0.0.1/tcp/4101/p2p/${peerId}`,
      identity: { publicKey: identity.publicKey.toString("base64") }, identityBinding: peerId,
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, allocatedBytes: 100, availableBytes: 100 },
    };
    const record = await client.registerLibp2pWithIdentity(identity, descriptor);
    expect(record.transport).toBe("libp2p");
    expect((await client.nodes())[0].multiaddr).toBe(descriptor.multiaddr);
    await client.heartbeatLibp2pWithIdentity(identity, descriptor);
    await client.unregisterWithIdentity(identity, peerId);
    expect(await client.nodes()).toHaveLength(0);
    await coordinator.close();
  });
});
