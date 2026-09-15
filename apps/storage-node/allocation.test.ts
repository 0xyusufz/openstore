import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { createStorageNode } from "./index.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("safe storage allocation & quotas (OPENSTORE-015)", () => {
  it("1. allocation limit is reported correctly", async () => {
    const dir = await tempDir("openstore-alloc-1-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 12345 });
    await node.listen(0, "127.0.0.1");
    const cap = await node.getCapacity();
    expect(cap.allocatedBytes ?? cap.totalBytes).toBe(12345);
    expect(cap.usedBytes).toBe(0);
    expect(cap.availableBytes).toBe(12345);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("2. writes within quota succeed", async () => {
    const dir = await tempDir("openstore-alloc-2-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 500 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "within-quota", data: Buffer.alloc(100).toString("base64") }),
    });
    expect([200, 201]).toContain(res.status);
    const cap = await node.getCapacity();
    expect(cap.usedBytes).toBe(100);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("3. write beyond quota returns 507", async () => {
    const dir = await tempDir("openstore-alloc-3-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 100 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "too-big", data: Buffer.alloc(200).toString("base64") }),
    });
    expect(res.status).toBe(507);
    const json = (await res.json()) as { error: string; capacity: { allocatedBytes?: number; totalBytes?: number } };
    expect(json.error).toMatch(/insufficient storage/i);
    expect((json.capacity.allocatedBytes ?? json.capacity.totalBytes)).toBe(100);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("4. overwrite accounts only for size difference", async () => {
    const dir = await tempDir("openstore-alloc-4-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 150 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    // Initial 100 bytes
    await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "overwrite", data: Buffer.alloc(100).toString("base64") }),
    });
    expect((await node.getCapacity()).usedBytes).toBe(100);
    // Overwrite with 120 bytes: should succeed (100 -100 +120 =120 <=150)
    const res1 = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "overwrite", data: Buffer.alloc(120).toString("base64") }),
    });
    expect([200, 201]).toContain(res1.status);
    expect((await node.getCapacity()).usedBytes).toBe(120);
    // Overwrite with 200 bytes: should fail (120 -120 +200 =200 >150? Actually used 120, new 200 => projected 200 >150, but need to compute: used 120, existing 120, new 200 => 200 >150 => 507)
    // Let's use 160 to exceed
    const res2 = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "overwrite", data: Buffer.alloc(160).toString("base64") }),
    });
    expect(res2.status).toBe(507);
    // Original still readable
    const get = await fetch(`${baseUrl}/pieces/overwrite`);
    expect(get.status).toBe(200);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("5. delete reclaims quota", async () => {
    const dir = await tempDir("openstore-alloc-5-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 200 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "to-delete", data: Buffer.alloc(100).toString("base64") }),
    });
    expect((await node.getCapacity()).usedBytes).toBe(100);
    await fetch(`${baseUrl}/pieces/to-delete`, { method: "DELETE" });
    expect((await node.getCapacity()).usedBytes).toBe(0);
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "after-delete", data: Buffer.alloc(190).toString("base64") }),
    });
    expect([200, 201]).toContain(res.status);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("6. quota does not expose physical disk details", async () => {
    const dir = await tempDir("openstore-alloc-6-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 500 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    // Fill partially
    await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "quota-check", data: Buffer.alloc(100).toString("base64") }),
    });
    const cap = await node.getCapacity();
    expect(cap.allocatedBytes ?? cap.totalBytes).toBe(500);
    expect(cap.usedBytes).toBe(100);
    expect(cap.availableBytes).toBe(400);
    // Ensure no disk free space leaked
    const json = JSON.stringify(cap);
    expect(json.toLowerCase()).not.toContain("disk");
    expect(json.toLowerCase()).not.toContain("free");
    // Registry also only shows allocated quota
    const registry = createRegistry();
    const id = createIdentity();
    registry.register("http://127.0.0.1:4000", id, cap);
    const rec = registry.get(id.publicKey.toString("base64"));
    expect((rec?.capacity.allocatedBytes ?? rec?.capacity.totalBytes)).toBe(500);
    expect(JSON.stringify(rec?.capacity).toLowerCase()).not.toContain("disk");
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("7. restart preserves configured allocation when persistence is used", async () => {
    const dir = await tempDir("openstore-alloc-7-");
    const regFile = join(await tempDir("openstore-reg-persist-7-"), "registry.json");
    const regDir = regFile.split("/").slice(0, -1).join("/");
    const identity = createIdentity();
    const registry1 = createRegistry({ persistencePath: regFile });
    const node = createStorageNode({ storageDir: dir, identity, registry: registry1, capacityBytes: 800 });
    await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${(node.server.address() as { port: number }).port}`;
    await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "persist-piece", data: Buffer.alloc(100).toString("base64") }),
    });
    // Wait for heartbeat to persist capacity
    await new Promise((r) => setTimeout(r, 120));
    // Check persistence before close (node still registered)
    const registryCheck = createRegistry({ persistencePath: regFile });
    const recCheck = registryCheck.get(identity.publicKey.toString("base64"));
    expect(recCheck).toBeDefined();
    expect((recCheck?.capacity.allocatedBytes ?? recCheck?.capacity.totalBytes)).toBe(800);
    await node.close();
    // After graceful close, node is unregistered, but restart should preserve allocation
    const registry2 = createRegistry({ persistencePath: regFile });
    // After close, registry should be empty (unregistered), but new node restart re-registers with same quota
    expect(registry2.list()).toHaveLength(0);
    const node2 = createStorageNode({ storageDir: dir, identity, registry: registry2, capacityBytes: 800 });
    await node2.listen(0, "127.0.0.1");
    const cap2 = await node2.getCapacity();
    expect(cap2.allocatedBytes ?? cap2.totalBytes).toBe(800);
    // Existing piece still readable
    const get = await fetch(`http://127.0.0.1:${(node2.server.address() as { port: number }).port}/pieces/persist-piece`);
    expect(get.status).toBe(200);
    await node2.close();
    await rm(dir, { recursive: true, force: true });
    await rm(regDir, { recursive: true, force: true });
  });

  it("8. path traversal remains blocked", async () => {
    const dir = await tempDir("openstore-alloc-8-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 1000 });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    for (const maliciousId of ["../evil", "../../etc/passwd", "a/b", "a..b//c"]) {
      const res = await fetch(`${baseUrl}/pieces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: maliciousId, data: Buffer.alloc(10).toString("base64") }),
      });
      expect(res.status).toBe(400);
    }
    for (const encoded of ["%2e%2e%2fevil", "%2fetc%2fpasswd"]) {
      const res = await fetch(`${baseUrl}/pieces/${encoded}`);
      expect(res.status).toBe(400);
    }
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("9. existing upload/download still work under quota", async () => {
    const dir = await tempDir("openstore-alloc-9-");
    const node = createStorageNode({ storageDir: dir, capacityBytes: 10 * 1024 * 1024 });
    const port = await node.listen(0, "127.0.0.1");
    const endpoint = { id: "alloc-9-node", baseUrl: `http://127.0.0.1:${port}` };
    const { uploadBuffer } = await import("../client/upload.js");
    const { downloadBuffer } = await import("../client/download.js");
    const data = Buffer.from("quota-upload-download-test");
    const { manifest, encryptionKey } = await uploadBuffer(data, "quota.txt", [endpoint]);
    expect(manifest.size).toBe(data.length);
    const recovered = await downloadBuffer(manifest, encryptionKey, [endpoint]);
    expect(recovered.equals(data)).toBe(true);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });
});
