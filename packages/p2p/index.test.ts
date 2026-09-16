import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import {
  createP2PNodeDescriptor,
  validateP2PNodeAddress,
  validateP2PNodeIdentity,
} from "./index.js";

describe("P2P node model (OPENSTORE-032)", () => {
  it("creates a public-only node descriptor from an Ed25519 identity", () => {
    const identity = createIdentity();
    const descriptor = createP2PNodeDescriptor(
      { nodeId: "node-1", baseUrl: "http://127.0.0.1:4101" },
      { publicKey: identity.publicKey.toString("base64") },
      { pieceStore: true, pieceGet: true, pieceDelete: true },
    );
    expect(descriptor.identity.publicKey).toBe(identity.publicKey.toString("base64"));
    expect(JSON.stringify(descriptor)).not.toContain(identity.privateKey.toString("base64"));
  });

  it("rejects invalid addresses and identity material", () => {
    expect(() => validateP2PNodeAddress({ nodeId: "n", baseUrl: "file:///tmp/node" })).toThrow(/http or https/i);
    expect(() => validateP2PNodeAddress({ nodeId: "n", baseUrl: "https://user:pass@example.test" })).toThrow(/credentials/i);
    expect(() => validateP2PNodeIdentity({ publicKey: "not-a-key" })).toThrow(/Ed25519/i);
    expect(() => createP2PNodeDescriptor(
      { nodeId: "n", baseUrl: "http://127.0.0.1:1" },
      { publicKey: createIdentity().publicKey.toString("base64") },
      { pieceStore: true, pieceGet: false, pieceDelete: true },
    )).toThrow(/capabilities/i);
  });
});
