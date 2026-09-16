import { afterEach, describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import {
  createLibp2pStorageNode,
  Libp2pPieceTransport,
} from "./libp2p.js";
import type { Libp2pStorageNode } from "./libp2p.js";
import { peerIdFromOpenStorePublicKey } from "./identity-binding.js";

const nodes: Libp2pStorageNode[] = [];

afterEach(async () => {
  while (nodes.length > 0) {
    await nodes.pop()?.stop();
  }
});

describe("libp2p piece transport (OPENSTORE-033)", () => {
  it("uses the OpenStore Ed25519 identity as the deterministic libp2p identity", async () => {
    const identity = createIdentity();
    const node = await createLibp2pStorageNode({
      applicationIdentity: { publicKey: identity.publicKey.toString("base64") },
      applicationPrivateKey: identity.privateKey,
      storePiece: async () => 201,
      getPiece: async () => null,
      deletePiece: async () => 204,
    });
    nodes.push(node);
    expect(node.peerId).toBe(peerIdFromOpenStorePublicKey(identity.publicKey));
    await node.start();
  });

  it("connects two local nodes and stores, gets, and deletes opaque bytes", async () => {
    const stored = new Map<string, Buffer>();
    const first = await createLibp2pStorageNode({
      applicationIdentity: { publicKey: createIdentity().publicKey.toString("base64") },
      storePiece: async () => 201,
      getPiece: async () => null,
      deletePiece: async () => 204,
    });
    const second = await createLibp2pStorageNode({
      applicationIdentity: { publicKey: createIdentity().publicKey.toString("base64") },
      storePiece: async (pieceId, data) => {
        stored.set(pieceId, Buffer.from(data));
        return 201;
      },
      getPiece: async (pieceId) => stored.get(pieceId) ?? null,
      deletePiece: async (pieceId) => {
        stored.delete(pieceId);
        return 204;
      },
    });
    nodes.push(first, second);
    await first.start();
    await second.start();

    const transport = new Libp2pPieceTransport();
    const address = {
      nodeId: second.peerId,
      baseUrl: `libp2p://${second.peerId}`,
      multiaddr: second.listenAddrs[0],
    };
    const bytes = Buffer.from("encrypted-piece-bytes");
    expect(await transport.storePiece(address, "piece-1", bytes, { timeoutMs: 5_000 })).toEqual({ status: 201 });
    expect(await transport.getPiece(address, "piece-1", { timeoutMs: 5_000 })).toMatchObject({ status: 200, bytes });
    expect(await transport.deletePiece(address, "piece-1", { timeoutMs: 5_000 })).toEqual({ status: 204 });
    expect(await transport.getPiece(address, "piece-1", { timeoutMs: 5_000 })).toMatchObject({ status: 404 });
  }, 20_000);

  it("rejects malformed piece requests before dialing", async () => {
    const transport = new Libp2pPieceTransport();
    const address = { nodeId: "peer", baseUrl: "libp2p://peer", multiaddr: "/ip4/127.0.0.1/tcp/1/p2p/peer" };
    await expect(transport.storePiece(address, "../escape", Buffer.from("x"), { timeoutMs: 100 })).rejects.toThrow(/malformed|piece/i);
  });

  it("stops cleanly and removes active connections", async () => {
    const node = await createLibp2pStorageNode({
      applicationIdentity: { publicKey: createIdentity().publicKey.toString("base64") },
      storePiece: async () => 201,
      getPiece: async () => null,
      deletePiece: async () => 204,
    });
    nodes.push(node);
    await node.start();
    expect(node.listenAddrs.length).toBeGreaterThan(0);
    const transport = new Libp2pPieceTransport();
    const address = { nodeId: node.peerId, baseUrl: `libp2p://${node.peerId}`, multiaddr: node.listenAddrs[0] };
    await node.stop();
    expect(node.node.status).toBe("stopped");
    expect(node.node.getMultiaddrs()).toHaveLength(0);
    await expect(transport.health(address, { timeoutMs: 500 })).resolves.toMatchObject({ available: false });
  });
});
