import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import {
  assertPeerIdMatchesOpenStoreIdentity,
  peerIdFromOpenStorePrivateKey,
  peerIdFromOpenStorePublicKey,
} from "./identity-binding.js";
import { validateP2PPeerDescriptor } from "./index.js";

describe("OpenStore/libp2p identity binding (OPENSTORE-037)", () => {
  it("derives the same PeerId deterministically from the same identity", () => {
    const identity = createIdentity();
    expect(peerIdFromOpenStorePrivateKey(identity.privateKey, identity.publicKey))
      .toBe(peerIdFromOpenStorePrivateKey(identity.privateKey, identity.publicKey));
    expect(peerIdFromOpenStorePrivateKey(identity.privateKey, identity.publicKey))
      .toBe(peerIdFromOpenStorePublicKey(identity.publicKey));
  });

  it("accepts a valid public binding and rejects a mismatched key", () => {
    const identity = createIdentity();
    const peerId = peerIdFromOpenStorePublicKey(identity.publicKey);
    assertPeerIdMatchesOpenStoreIdentity(peerId, identity.publicKey);
    expect(() => assertPeerIdMatchesOpenStoreIdentity(`${peerId}x`, identity.publicKey)).toThrow(/does not match/i);
    expect(() => validateP2PPeerDescriptor({
      nodeId: peerId,
      baseUrl: `libp2p://${peerId}`,
      identity: { publicKey: createIdentity().publicKey.toString("base64") },
      identityBinding: peerId,
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    })).toThrow(/identity|peer ID/i);
  });

  it("keeps private identity material out of public records", () => {
    const identity = createIdentity();
    const peerId = peerIdFromOpenStorePublicKey(identity.publicKey);
    const record = {
      nodeId: peerId,
      baseUrl: `libp2p://${peerId}`,
      identity: { publicKey: identity.publicKey.toString("base64") },
      identityBinding: peerId,
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
    expect(JSON.stringify(record)).not.toContain(identity.privateKey.toString("base64"));
    expect(JSON.stringify(record)).not.toContain(identity.recoveryPhrase.join(" "));
    expect(() => validateP2PPeerDescriptor({ ...record, privateKey: identity.privateKey.toString("base64") })).toThrow(/private/i);
  });
});
