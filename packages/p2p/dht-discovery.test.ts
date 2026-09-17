import { afterEach, describe, expect, it } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { peerIdFromOpenStorePrivateKey } from "./identity-binding.js";
import { createIdentity } from "../identity/index.js";
import { classifyDhtRecord, createDhtRecord, deduplicateDhtDescriptors, DhtPeerDiscovery } from "./dht-discovery.js";
import { createLibp2pStorageNode, type Libp2pStorageNode } from "./libp2p.js";
import type { P2PPeerDescriptor } from "./index.js";

const nodes: Libp2pStorageNode[] = [];

afterEach(async () => {
  while (nodes.length > 0) await nodes.pop()?.stop();
});

function options(discovery: DhtPeerDiscovery) {
  const identity = createIdentity();
  return {
    applicationIdentity: { publicKey: identity.publicKey.toString("base64") },
    applicationPrivateKey: identity.privateKey,
    discovery,
    discoveryRefreshIntervalMs: 50,
    storePiece: async () => 201,
    getPiece: async () => null,
    deletePiece: async () => 204,
  };
}

describe("DHT peer discovery (OPENSTORE-036)", () => {
  it("classifies bounded fresh records and rejects stale/future/malformed timestamps", () => {
    const identity = createIdentity();
    const descriptor: P2PPeerDescriptor = {
      nodeId: peerIdFromOpenStorePrivateKey(identity.privateKey, identity.publicKey),
      baseUrl: "libp2p://peer",
      identity: { publicKey: identity.publicKey.toString("base64") },
      identityBinding: peerIdFromOpenStorePrivateKey(identity.privateKey, identity.publicKey),
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
    expect(classifyDhtRecord(createDhtRecord(descriptor, 1_000), 1_001).state).toBe("fresh");
    expect(classifyDhtRecord(createDhtRecord(descriptor, 1_000), 301_001).state).toBe("stale");
    expect(classifyDhtRecord(createDhtRecord(descriptor, 40_000), 0).state).toBe("invalid");
    expect(classifyDhtRecord({ version: 1, publishedAt: "now", descriptor }).state).toBe("invalid");
  });

  it("rejects DHT records with conflicting identity bindings", () => {
    const identity = createIdentity();
    const descriptor = {
      nodeId: "not-the-peer",
      baseUrl: "libp2p://not-the-peer",
      identity: { publicKey: identity.publicKey.toString("base64") },
      identityBinding: "not-the-peer",
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
    expect(classifyDhtRecord({ version: 1, publishedAt: Date.now(), descriptor }).state).toBe("invalid");
  });

  it("deduplicates descriptor observations deterministically", () => {
    const identity = createIdentity();
    const descriptor: P2PPeerDescriptor = {
      nodeId: peerIdFromOpenStorePrivateKey(identity.privateKey, identity.publicKey),
      baseUrl: "libp2p://peer",
      identity: { publicKey: identity.publicKey.toString("base64") },
      identityBinding: peerIdFromOpenStorePrivateKey(identity.privateKey, identity.publicKey),
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
    expect(deduplicateDhtDescriptors([descriptor, descriptor])).toHaveLength(1);
  });

  it("publishes and discovers a local peer record, then connects", async () => {
    const secondDiscovery = new DhtPeerDiscovery();
    const second = await createLibp2pStorageNode(options(secondDiscovery));
    nodes.push(second);
    await second.start();

    const secondDescriptor: P2PPeerDescriptor = {
      nodeId: second.peerId,
      baseUrl: `libp2p://${second.peerId}`,
      multiaddr: second.listenAddrs[0],
      identity: second.applicationIdentity,
      capabilities: second.capabilities,
      identityBinding: second.peerId,
    };
    const firstDiscovery = new DhtPeerDiscovery([secondDescriptor]);
    const first = await createLibp2pStorageNode(options(firstDiscovery));
    nodes.push(first);
    await first.start();

    const firstDescriptor: P2PPeerDescriptor = {
      nodeId: first.peerId,
      baseUrl: `libp2p://${first.peerId}`,
      multiaddr: first.listenAddrs[0],
      identity: first.applicationIdentity,
      capabilities: first.capabilities,
      identityBinding: first.peerId,
    };
    secondDiscovery.addBootstrapPeer(firstDescriptor);
    await secondDiscovery.refreshNow({
      onRefresh: async (peers) => {
        expect(peers.some((peer) => peer.nodeId === first.peerId)).toBe(true);
        await second.node.dial(multiaddr(firstDescriptor.multiaddr!));
      },
    });
    await waitFor(() => second.node.getConnections().some((connection) => connection.remotePeer.toString() === first.peerId));
  }, 30_000);

  it("isolates invalid and unreachable bootstrap records", async () => {
    const invalid = {
      nodeId: "bad",
      baseUrl: "libp2p://bad",
      multiaddr: "/udp/1",
      identity: { publicKey: createIdentity().publicKey.toString("base64") },
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
      recoveryPhrase: "secret",
    } as unknown as P2PPeerDescriptor;
    expect(() => new DhtPeerDiscovery([invalid])).toThrow(/private|unsupported/i);

    const unreachableIdentity = createIdentity();
    const unreachable: P2PPeerDescriptor = {
      nodeId: peerIdFromOpenStorePrivateKey(unreachableIdentity.privateKey, unreachableIdentity.publicKey),
      baseUrl: "libp2p://unreachable",
      multiaddr: "/ip4/127.0.0.1/tcp/1",
      identity: { publicKey: unreachableIdentity.publicKey.toString("base64") },
      identityBinding: peerIdFromOpenStorePrivateKey(unreachableIdentity.privateKey, unreachableIdentity.publicKey),
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
    const discovery = new DhtPeerDiscovery([unreachable]);
    const node = await createLibp2pStorageNode(options(discovery));
    nodes.push(node);
    await expect(node.start()).resolves.toBeUndefined();
  }, 30_000);

  it("stops cleanly and is idempotent", async () => {
    const discovery = new DhtPeerDiscovery();
    const node = await createLibp2pStorageNode(options(discovery));
    nodes.push(node);
    await node.start();
    await node.start();
    await node.stop();
    await node.stop();
    await expect(discovery.discover()).rejects.toThrow(/not started/i);
  }, 30_000);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}
