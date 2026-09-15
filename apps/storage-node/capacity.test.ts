import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { createStorageNode } from "./index.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("storage capacity & node health (OPENSTORE-012)", () => {
  it("1. configured capacity is reported correctly", async () => {
    const registry = createRegistry();
    const id = createIdentity();
    const dir = await tempDir("openstore-cap-1-");
    const node = createStorageNode({ storageDir: dir, identity: id, registry, capacityBytes: 4096 });
    await node.listen(0, "127.0.0.1");
    const cap = await node.getCapacity();
    expect(cap.totalBytes).toBe(4096);
    expect(cap.usedBytes).toBe(0);
    expect(cap.availableBytes).toBe(4096);
    const rec = registry.get(id.publicKey.toString("base64"));
    expect(rec?.capacity.totalBytes).toBe(4096);
    expect(rec?.capacity.usedBytes).toBe(0);
    expect(rec?.capacity.availableBytes).toBe(4096);
    // Never expose files/piece contents in capacity
    expect(JSON.stringify(rec)).not.toContain("privateKey");
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("2. used/available capacity updates after storing a piece", async () => {
    const registry = createRegistry();
    const id = createIdentity();
    const dir = await tempDir("openstore-cap-2-");
    const node = createStorageNode({ storageDir: dir, identity: id, registry, capacityBytes: 2048, registryHeartbeatIntervalMs: 50 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const data = Buffer.alloc(100, 0xaa);
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "cap-piece-1", data: data.toString("base64") }),
    });
    expect([200, 201]).toContain(res.status);
    const cap = await node.getCapacity();
    expect(cap.usedBytes).toBe(100);
    expect(cap.availableBytes).toBe(1948);
    // Wait for heartbeat to propagate to registry
    await new Promise((r) => setTimeout(r, 120));
    const rec = registry.get(id.publicKey.toString("base64"));
    expect(rec?.capacity.usedBytes).toBe(100);
    expect(rec?.capacity.availableBytes).toBe(1948);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("3. piece exceeding capacity is rejected", async () => {
    const dir = await tempDir("openstore-cap-3-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 150 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const big = Buffer.alloc(200, 0xbb);
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "too-big", data: big.toString("base64") }),
    });
    expect(res.status).toBe(507);
    const json = (await res.json()) as { error: string; capacity?: { totalBytes: number } };
    expect(json.error).toMatch(/insufficient storage/i);
    // Ensure piece not stored
    expect((await fetch(`${baseUrl}/pieces/too-big`)).status).toBe(404);
    // Existing piece still works if within capacity
    const small = Buffer.alloc(50, 0xcc);
    const ok = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "small-ok", data: small.toString("base64") }),
    });
    expect([200, 201]).toContain(ok.status);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("4. deleting a piece frees capacity", async () => {
    const dir = await tempDir("openstore-cap-4-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 200 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const data = Buffer.alloc(80, 0xdd);
    await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "to-delete", data: data.toString("base64") }),
    });
    expect((await node.getCapacity()).usedBytes).toBe(80);
    const del = await fetch(`${baseUrl}/pieces/to-delete`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await node.getCapacity()).usedBytes).toBe(0);
    expect((await node.getCapacity()).availableBytes).toBe(200);
    // Now big piece should fit after free
    const big = Buffer.alloc(150, 0xee);
    const res2 = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "big-after-free", data: big.toString("base64") }),
    });
    expect([200, 201]).toContain(res2.status);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("5. heartbeat updates capacity/health", async () => {
    const registry = createRegistry({ heartbeatTimeoutMs: 500 });
    const id = createIdentity();
    const dir = await tempDir("openstore-cap-5-");
    const node = createStorageNode({
      storageDir: dir,
      identity: id,
      registry,
      capacityBytes: 1000,
      registryHeartbeatIntervalMs: 50,
    });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    // Initially used 0
    expect(registry.get(id.publicKey.toString("base64"))?.capacity.usedBytes).toBe(0);
    // Store piece
    await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "hb-cap", data: Buffer.alloc(300).toString("base64") }),
    });
    // Wait for heartbeat
    await new Promise((r) => setTimeout(r, 120));
    const rec = registry.get(id.publicKey.toString("base64"));
    expect(rec?.capacity.usedBytes).toBe(300);
    expect(rec?.available).toBe(true);
    expect(typeof rec?.lastSeen).toBe("number");
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("6. registry stores latest capacity information", async () => {
    const registry = createRegistry();
    const id = createIdentity();
    const dir = await tempDir("openstore-cap-6-");
    const node = createStorageNode({ storageDir: dir, identity: id, registry, capacityBytes: 5000, registryHeartbeatIntervalMs: 50 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    for (const size of [100, 200]) {
      await fetch(`${baseUrl}/pieces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: `cap-6-${size}`, data: Buffer.alloc(size).toString("base64") }),
      });
      await new Promise((r) => setTimeout(r, 80));
      const rec = registry.get(id.publicKey.toString("base64"));
      // used should be cumulative
      expect(rec?.capacity.usedBytes).toBeGreaterThanOrEqual(size);
      const total = rec!.capacity.allocatedBytes ?? rec!.capacity.totalBytes ?? 0;
      expect(rec?.capacity.availableBytes).toBe(total - rec!.capacity.usedBytes);
    }
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("7. unavailable/expired node remains excluded from discovery", async () => {
    const registry = createRegistry({ heartbeatTimeoutMs: 80 });
    const id = createIdentity();
    const dir = await tempDir("openstore-cap-7-");
    const node = createStorageNode({
      storageDir: dir,
      identity: id,
      registry,
      capacityBytes: 1000,
      registryHeartbeatIntervalMs: 30,
    });
    await node.listen(0, "127.0.0.1");
    expect(registry.listAvailable()).toHaveLength(1);
    await node.close();
    // After close, unregistered, so not available
    expect(registry.listAvailable()).toHaveLength(0);
    // Re-register and let expire without heartbeat (stop heartbeats by closing)
    const node2 = createStorageNode({
      storageDir: dir,
      identity: id,
      registry,
      capacityBytes: 1000,
      registryHeartbeatIntervalMs: 10000, // long interval, won't heartbeat in time
    });
    await node2.listen(0, "127.0.0.1");
    expect(registry.listAvailable()).toHaveLength(1);
    // Wait for expiry
    await new Promise((r) => setTimeout(r, 120));
    expect(registry.listAvailable()).toHaveLength(0);
    // Discovery helper should also exclude
    const { discoverAvailableEndpoints } = await import("../client/discovery.js");
    expect(discoverAvailableEndpoints(registry)).toHaveLength(0);
    await node2.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("8. private keys and piece contents are never exposed", async () => {
    const registry = createRegistry();
    const id = createIdentity();
    const dir = await tempDir("openstore-cap-8-");
    const node = createStorageNode({ storageDir: dir, identity: id, registry, capacityBytes: 2000 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const secret = Buffer.from("top-secret-piece-content");
    await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "secret-piece", data: secret.toString("base64") }),
    });
    const rec = registry.get(id.publicKey.toString("base64"));
    const recJson = JSON.stringify(rec);
    expect(recJson).not.toContain(id.privateKey.toString("base64"));
    expect(recJson).not.toContain(id.privateKey.toString("hex"));
    expect(recJson).not.toContain(secret.toString("base64"));
    expect(recJson).not.toContain("top-secret");
    // Registry record should not contain filenames or piece ids
    expect(recJson).not.toContain("secret-piece");
    // Check storage dir listing not exposed via registry
    const files = await readdir(dir);
    expect(files).toContain("secret-piece");
    // But registry doesn't expose files
    expect(registry.listAvailable()[0]?.baseUrl).toBe(baseUrl);
    // HTTP responses for pieces don't leak private keys
    const getRes = await fetch(`${baseUrl}/pieces/secret-piece`);
    const body = await getRes.text();
    expect(body).not.toContain(id.privateKey.toString("base64"));
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });
});
