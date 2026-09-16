import { afterEach, describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { StaticPeerDiscovery } from "./discovery.js";
import { createLibp2pStorageNode, type Libp2pStorageNode } from "./libp2p.js";
import type { P2PPeerDescriptor } from "./index.js";

const nodes: Libp2pStorageNode[] = [];

afterEach(async () => {
  while (nodes.length > 0) await nodes.pop()?.stop();
});

function storageOptions(discovery?: StaticPeerDiscovery) {
  return {
    applicationIdentity: { publicKey: createIdentity().publicKey.toString("base64") },
    storePiece: async () => 201,
    getPiece: async () => null,
    deletePiece: async () => 204,
    ...(discovery === undefined ? {} : { discovery }),
  };
}

describe("static peer discovery (OPENSTORE-034)", () => {
  it("discovers and connects to a configured bootstrap peer", async () => {
    const first = await createLibp2pStorageNode(storageOptions());
    nodes.push(first);
    await first.start();
    const bootstrap: P2PPeerDescriptor = {
      nodeId: first.peerId,
      baseUrl: `libp2p://${first.peerId}`,
      multiaddr: first.listenAddrs[0],
      identity: first.applicationIdentity,
      capabilities: first.capabilities,
    };
    const discovery = new StaticPeerDiscovery([bootstrap]);
    const second = await createLibp2pStorageNode(storageOptions(discovery));
    nodes.push(second);
    await second.start();

    expect(second.discoveredPeers.map((peer) => peer.nodeId)).toEqual([first.peerId]);
    expect(second.node.getConnections().some((connection) => connection.remotePeer.toString() === first.peerId)).toBe(true);
  }, 20_000);

  it("rejects malformed, unsupported, and secret-bearing descriptors", () => {
    const valid = {
      nodeId: "peer",
      baseUrl: "libp2p://peer",
      multiaddr: "/udp/1234",
      identity: { publicKey: createIdentity().publicKey.toString("base64") },
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    } as P2PPeerDescriptor;
    expect(() => new StaticPeerDiscovery([valid])).toThrow(/unsupported protocol/i);
    expect(() => new StaticPeerDiscovery([{ ...valid, multiaddr: "/ip4/127.0.0.1/tcp/1/p2p/other" }])).toThrow(/identity/i);
    expect(() => new StaticPeerDiscovery([{ ...valid, multiaddr: "/ip4/127.0.0.1/tcp/1", privateKey: "secret" } as P2PPeerDescriptor])).toThrow(/private/i);
  });

  it("deduplicates bootstrap peers and tolerates unreachable peers", async () => {
    const identity = { publicKey: createIdentity().publicKey.toString("base64") };
    const unreachable: P2PPeerDescriptor = {
      nodeId: "12D3KooWJ5rVx8z7LzYyM8n4q2k7b3s6d9f1h5j8p2c4v6x8z",
      baseUrl: "libp2p://unreachable",
      multiaddr: "/ip4/127.0.0.1/tcp/1",
      identity,
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
    const discovery = new StaticPeerDiscovery([unreachable, unreachable]);
    const node = await createLibp2pStorageNode(storageOptions(discovery));
    nodes.push(node);
    await expect(node.start()).resolves.toBeUndefined();
    expect(node.discoveredPeers).toHaveLength(1);
  }, 20_000);

  it("stops discovery and releases advertised state", async () => {
    const discovery = new StaticPeerDiscovery();
    const node = await createLibp2pStorageNode(storageOptions(discovery));
    nodes.push(node);
    await node.start();
    await node.stop();
    await expect(discovery.discover()).rejects.toThrow(/not started/i);
  });

  it("rejects invalid refresh intervals", async () => {
    const discovery = new StaticPeerDiscovery();
    const descriptor = {
      nodeId: "peer",
      baseUrl: "libp2p://peer",
      identity: { publicKey: createIdentity().publicKey.toString("base64") },
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
    await expect(discovery.start(descriptor, { refreshIntervalMs: 0 })).rejects.toThrow(/refresh interval/i);
  });

  it("refreshes and connects to a peer advertised after startup", async () => {
    const secondDiscovery = new StaticPeerDiscovery();
    const second = await createLibp2pStorageNode({
      ...storageOptions(secondDiscovery),
      discoveryRefreshIntervalMs: 20,
    });
    nodes.push(second);
    await second.start();

    const firstDiscovery = new StaticPeerDiscovery();
    const first = await createLibp2pStorageNode(storageOptions(firstDiscovery));
    nodes.push(first);
    await first.start();

    await waitFor(() => second.discoveredPeers.some((peer) => peer.nodeId === first.peerId));
    await waitFor(() => second.node.getConnections().some((connection) => connection.remotePeer.toString() === first.peerId));
    const connectedCount = second.node.getConnections().filter((connection) => connection.remotePeer.toString() === first.peerId).length;
    expect(connectedCount).toBeLessThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(second.node.getConnections().filter((connection) => connection.remotePeer.toString() === first.peerId)).toHaveLength(connectedCount);
  }, 20_000);

  it("keeps refreshing around unreachable peers and has idempotent lifecycle", async () => {
    const identity = { publicKey: createIdentity().publicKey.toString("base64") };
    const unreachable: P2PPeerDescriptor = {
      nodeId: "12D3KooWJ5rVx8z7LzYyM8n4q2k7b3s6d9f1h5j8p2c4v6x8z",
      baseUrl: "libp2p://unreachable",
      multiaddr: "/ip4/127.0.0.1/tcp/1",
      identity,
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
    const discovery = new StaticPeerDiscovery([unreachable]);
    const node = await createLibp2pStorageNode({
      ...storageOptions(discovery),
      discoveryRefreshIntervalMs: 10,
    });
    nodes.push(node);
    await node.start();
    await node.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await node.stop();
    await node.stop();
    await expect(discovery.discover()).rejects.toThrow(/not started/i);
  }, 20_000);

  it("emits verified connection lifecycle events", async () => {
    const events: string[] = [];
    const first = await createLibp2pStorageNode(storageOptions());
    nodes.push(first);
    await first.start();
    const discovery = new StaticPeerDiscovery([{
      nodeId: first.peerId,
      baseUrl: `libp2p://${first.peerId}`,
      multiaddr: first.listenAddrs[0],
      identity: first.applicationIdentity,
      capabilities: first.capabilities,
    }]);
    const second = await createLibp2pStorageNode({
      ...storageOptions(discovery),
      onConnectionEvent: (event) => events.push(event.type),
    });
    nodes.push(second);
    await second.start();
    expect(events).toContain("connection.open");
    const connection = second.node.getConnections().find((item) => item.remotePeer.toString() === first.peerId);
    await connection?.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toContain("connection.close");
  }, 20_000);

  it("bounds reconnect attempts and emits exhaustion", async () => {
    const events: string[] = [];
    const first = await createLibp2pStorageNode(storageOptions());
    nodes.push(first);
    await first.start();
    const discovery = new StaticPeerDiscovery([{
      nodeId: first.peerId,
      baseUrl: `libp2p://${first.peerId}`,
      multiaddr: first.listenAddrs[0],
      identity: first.applicationIdentity,
      capabilities: first.capabilities,
    }]);
    const second = await createLibp2pStorageNode({
      ...storageOptions(discovery),
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      maxReconnectAttempts: 2,
      onConnectionEvent: (event) => events.push(event.type),
    });
    nodes.push(second);
    await second.start();
    await waitFor(() => events.includes("connection.open"));
    await first.stop();
    await waitFor(() => events.includes("reconnect.exhausted"));
    expect(events.filter((event) => event === "reconnect.scheduled").length).toBe(2);
    expect(events).toContain("reconnect.exhausted");
  }, 20_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
