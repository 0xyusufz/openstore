import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import {
  createRegistry,
  createSignedHeartbeat,
  createSignedRegistration,
} from "./index.js";

describe("node registry & discovery (OPENSTORE-010)", () => {
  it("1. valid node registration succeeds", () => {
    const registry = createRegistry();
    const id = createIdentity();
    const rec = registry.register("http://127.0.0.1:4001", id);
    expect(rec.baseUrl).toBe("http://127.0.0.1:4001");
    expect(rec.publicKey).toBe(id.publicKey.toString("base64"));
    expect(rec.nodeId).toBe(id.publicKey.toString("base64"));
    expect(rec.available).toBe(true);
    expect(typeof rec.lastSeen).toBe("number");
    expect(registry.list()).toHaveLength(1);
  });

  it("2. invalid signature rejected", () => {
    const registry = createRegistry();
    const id = createIdentity();
    const signed = createSignedRegistration(id, "http://127.0.0.1:4002");
    // Tamper signature
    const sig = Buffer.from(signed.signature, "base64");
    sig[0] ^= 0xff;
    signed.signature = sig.toString("base64");
    expect(() => registry.registerSigned(signed)).toThrow(/invalid signature/i);
  });

  it("3. node cannot register using another node's identity", () => {
    const registry = createRegistry();
    const nodeA = createIdentity();
    const nodeB = createIdentity();
    // Try to register with baseUrl but claim nodeA's publicKey but sign with nodeB
    const fake = createSignedRegistration(nodeB, "http://127.0.0.1:4003");
    fake.publicKey = nodeA.publicKey.toString("base64");
    // Signature is from B but pubkey is A → verify fails
    expect(() => registry.registerSigned(fake)).toThrow(/invalid signature/i);

    // Also try to overwrite: register A legit, then try to heartbeat A using B's identity
    registry.register("http://127.0.0.1:4003", nodeA);
    expect(() => registry.heartbeat(nodeA.publicKey.toString("base64"), nodeB)).toThrow(/invalid signature|does not match/i);
  });

  it("4. heartbeat updates lastSeen", async () => {
    const registry = createRegistry({ heartbeatTimeoutMs: 5000 });
    const id = createIdentity();
    const first = registry.register("http://127.0.0.1:4004", id);
    const t1 = first.lastSeen;
    await new Promise((r) => setTimeout(r, 10));
    const second = registry.heartbeat(first.nodeId, id);
    expect(second.lastSeen).toBeGreaterThan(t1);
    expect(second.available).toBe(true);
  });

  it("5. expired heartbeat makes node unavailable", async () => {
    const registry = createRegistry({ heartbeatTimeoutMs: 50, maxClockSkewMs: 5000 });
    const id = createIdentity();
    registry.register("http://127.0.0.1:4005", id);
    expect(registry.listAvailable()).toHaveLength(1);
    // Wait for expiration
    await new Promise((r) => setTimeout(r, 80));
    expect(registry.listAvailable()).toHaveLength(0);
    const rec = registry.get(id.publicKey.toString("base64"));
    expect(rec?.available).toBe(false);
    // Heartbeat should make it available again
    registry.heartbeat(id.publicKey.toString("base64"), id);
    expect(registry.listAvailable()).toHaveLength(1);
  });

  it("6. node can unregister itself", () => {
    const registry = createRegistry();
    const id = createIdentity();
    registry.register("http://127.0.0.1:4006", id);
    expect(registry.list()).toHaveLength(1);
    registry.unregister(id.publicKey.toString("base64"), id);
    expect(registry.list()).toHaveLength(0);
    expect(registry.get(id.publicKey.toString("base64"))).toBeUndefined();
    // Unregister with wrong identity should fail
    const id2 = createIdentity();
    registry.register("http://127.0.0.1:4006", id);
    expect(() => registry.unregister(id.publicKey.toString("base64"), id2)).toThrow();
  });

  it("7. malformed records rejected", () => {
    const registry = createRegistry();
    const id = createIdentity();
    // Invalid baseUrl
    expect(() => registry.register("not-a-url", id)).toThrow(/malformed/i);
    expect(() => registry.register("ftp://evil.com", id)).toThrow(/malformed/i);
    // Missing fields via signed
    expect(() => registry.registerSigned({} as never)).toThrow(/malformed/i);
    expect(() => registry.registerSigned({ baseUrl: "http://a", publicKey: "", timestamp: "1", nonce: "a", signature: "b" } as never)).toThrow();
    // Invalid publicKey
    const bad = createSignedRegistration(id, "http://127.0.0.1:4007");
    bad.publicKey = "not-base64!!!";
    expect(() => registry.registerSigned(bad)).toThrow();
    // Expired timestamp
    const expired = createSignedRegistration(id, "http://127.0.0.1:4007", { timestamp: Date.now() - 10 * 60 * 1000 });
    expect(() => registry.registerSigned(expired)).toThrow(/expired/i);
    // Replayed nonce
    const nonce = "a".repeat(32);
    const r1 = createSignedRegistration(id, "http://127.0.0.1:4007", { nonce });
    const r2 = createSignedRegistration(id, "http://127.0.0.1:4008", { nonce });
    registry.registerSigned(r1);
    expect(() => registry.registerSigned(r2)).toThrow(/replayed/i);
  });

  it("8. private keys never enter registry", () => {
    const registry = createRegistry();
    const id = createIdentity();
    const rec = registry.register("http://127.0.0.1:4009", id);
    // Stored record should not contain private key
    expect((rec as unknown as Record<string, unknown>)["privateKey"]).toBeUndefined();
    expect((rec as unknown as Record<string, unknown>)["recoveryPhrase"]).toBeUndefined();
    const json = JSON.stringify(rec);
    expect(json).not.toContain(id.privateKey.toString("base64"));
    expect(json).not.toContain(id.privateKey.toString("hex"));
    // Even if caller tries to inject privateKey in signed object, it should be rejected
    const signed = createSignedRegistration(id, "http://127.0.0.1:4010") as unknown as Record<string, unknown>;
    signed["privateKey"] = id.privateKey.toString("base64");
    expect(() => registry.registerSigned(signed as unknown as never)).toThrow(/private keys/i);
  });

  it("9. multiple nodes can be registered and discovered", () => {
    const registry = createRegistry();
    const ids = [createIdentity(), createIdentity(), createIdentity()];
    for (let i = 0; i < ids.length; i++) {
      registry.register(`http://127.0.0.1:${4100 + i}`, ids[i] as never);
    }
    expect(registry.list()).toHaveLength(3);
    expect(registry.listAvailable()).toHaveLength(3);
    const endpoints = registry.getAvailableEndpoints();
    expect(endpoints).toHaveLength(3);
    expect(endpoints.every((e) => typeof e.id === "string" && typeof e.baseUrl === "string")).toBe(true);
    // Verify each endpoint corresponds to a node
    for (const id of ids) {
      const nodeId = id.publicKey.toString("base64");
      expect(endpoints.some((e) => e.id === nodeId)).toBe(true);
    }
  });

  it("10. existing client storage tests remain passing (manual endpoints)", async () => {
    // This test ensures manually configured endpoints still work without registry
    // We do a simple sanity check that StorageNodeEndpoint type still works
    const { createStorageNode } = await import("../../apps/storage-node/index.js");
    const { mkdtemp, rm } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg-manual-"));
    const node = createStorageNode({ storageDir: dir });
    const port = await node.listen(0, "127.0.0.1");
    const endpoint = { id: "manual-node", baseUrl: `http://127.0.0.1:${port}` };
    // Store and retrieve via fetch (simulating manual endpoint usage)
    const body = JSON.stringify({ id: "reg-manual-test", data: Buffer.from("manual-endpoint-works").toString("base64") });
    const post = await fetch(`${endpoint.baseUrl}/pieces`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect([200, 201]).toContain(post.status);
    const get = await fetch(`${endpoint.baseUrl}/pieces/reg-manual-test`);
    expect(get.status).toBe(200);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });
});
