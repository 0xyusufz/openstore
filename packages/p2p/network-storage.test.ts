import { afterEach, describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { deletePieceFromNodes, getPieceFromNodes, storePieceOnNodes, type StorageNodeEndpoint } from "../../apps/client/index.js";
import { Libp2pPieceTransport } from "./libp2p.js";
import { createLibp2pStorageNode, type Libp2pStorageNode } from "./libp2p.js";

const nodes: Libp2pStorageNode[] = [];

afterEach(async () => {
  while (nodes.length > 0) await nodes.pop()?.stop();
});

it("uploads, downloads, and deletes opaque pieces through libp2p", async () => {
  const identity = createIdentity();
  const pieces = new Map<string, Buffer>();
  const node = await createLibp2pStorageNode({
    applicationIdentity: { publicKey: identity.publicKey.toString("base64") },
    applicationPrivateKey: identity.privateKey,
    storePiece: async (id, data) => {
      pieces.set(id, Buffer.from(data));
      return 201;
    },
    getPiece: async (id) => pieces.get(id) ?? null,
    deletePiece: async (id) => {
      pieces.delete(id);
      return 204;
    },
  });
  nodes.push(node);
  await node.start();
  const endpoint: StorageNodeEndpoint = {
    id: node.peerId,
    baseUrl: `libp2p://${node.peerId}`,
    multiaddr: node.listenAddrs[0],
    identityBinding: node.peerId,
    identity: { publicKey: identity.publicKey.toString("base64") },
  };
  const transport = new Libp2pPieceTransport();
  const bytes = Buffer.from("opaque encrypted bytes");
  const stored = await storePieceOnNodes("network-piece", bytes, [endpoint], { transport });
  expect(stored.succeeded).toHaveLength(1);
  expect((await getPieceFromNodes("network-piece", [endpoint])).bytes).toEqual(bytes);
  await deletePieceFromNodes("network-piece", [endpoint], { transport });
  await expect(getPieceFromNodes("network-piece", [endpoint], { transport, retryAttempts: 1 })).rejects.toThrow(/unavailable/i);
}, 20_000);

it("falls back from an unavailable libp2p replica to a valid replica", async () => {
  const identity = createIdentity();
  const pieces = new Map<string, Buffer>();
  const node = await createLibp2pStorageNode({
    applicationIdentity: { publicKey: identity.publicKey.toString("base64") },
    applicationPrivateKey: identity.privateKey,
    storePiece: async (id, data) => {
      pieces.set(id, Buffer.from(data));
      return 201;
    },
    getPiece: async (id) => pieces.get(id) ?? null,
    deletePiece: async () => 204,
  });
  nodes.push(node);
  await node.start();
  const valid: StorageNodeEndpoint = { id: node.peerId, baseUrl: `libp2p://${node.peerId}`, multiaddr: node.listenAddrs[0], identityBinding: node.peerId, identity: { publicKey: identity.publicKey.toString("base64") } };
  const unavailable: StorageNodeEndpoint = { id: "12D3KooWJ5rVx8z7LzYyM8n4q2k7b3s6d9f1h5j8p2c4v6x8z", baseUrl: "libp2p://missing", multiaddr: "/ip4/127.0.0.1/tcp/1", identityBinding: "12D3KooWJ5rVx8z7LzYyM8n4q2k7b3s6d9f1h5j8p2c4v6x8z" };
  const transport = new Libp2pPieceTransport();
  await storePieceOnNodes("fallback-piece", Buffer.from("data"), [valid], { transport });
  expect((await getPieceFromNodes("fallback-piece", [unavailable, valid], { transport, retryAttempts: 1 })).from.id).toBe(valid.id);
});
