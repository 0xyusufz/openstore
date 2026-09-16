import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { peerIdFromOpenStorePublicKey } from "../p2p/identity-binding.js";
import type { P2PPeerDescriptor } from "../p2p/index.js";
import { createRegistry } from "./index.js";

function peer(): P2PPeerDescriptor {
  const identity = createIdentity();
  const nodeId = peerIdFromOpenStorePublicKey(identity.publicKey);
  return {
    nodeId,
    baseUrl: `libp2p://${nodeId}`,
    multiaddr: `/ip4/127.0.0.1/tcp/4101/p2p/${nodeId}`,
    identity: { publicKey: identity.publicKey.toString("base64") },
    identityBinding: nodeId,
    capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, maxPieceBytes: 1024 },
  };
}

describe("discovered peer placement integration", () => {
  it("registers validated libp2p peers with placement metadata and removes them", () => {
    const registry = createRegistry();
    const discovered = peer();
    const record = registry.registerDiscoveredPeer(discovered, { availableBytes: 4096 });
    expect(record.transport).toBe("libp2p");
    expect(record.multiaddr).toBe(discovered.multiaddr);
    expect(registry.getAvailableEndpoints()[0]).toMatchObject({
      id: discovered.nodeId,
      baseUrl: discovered.baseUrl,
      multiaddr: discovered.multiaddr,
      identityBinding: discovered.identityBinding,
    });
    registry.removeDiscoveredPeer(discovered.nodeId);
    expect(registry.get(discovered.nodeId)).toBeUndefined();
  });

  it("rejects invalid bindings and secret-bearing metadata", () => {
    const registry = createRegistry();
    const discovered = peer();
    expect(() => registry.registerDiscoveredPeer({ ...discovered, identityBinding: "wrong" }))
      .toThrow(/identity|peer/i);
    expect(() => registry.registerDiscoveredPeer({ ...discovered, recoveryPhrase: "secret" } as never))
      .toThrow(/secret|private|phrase/i);
  });
});
