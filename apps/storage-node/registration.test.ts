import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { createStorageNode } from "./index.js";
import { discoverAvailableEndpoints, mergeEndpoints } from "../client/discovery.js";
import type { StorageNodeEndpoint } from "../client/index.js";

describe("node registration + client discovery integration (OPENSTORE-011)", () => {
  it("1. node registers on startup", async () => {
    const registry = createRegistry();
    const identity = createIdentity();
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg011-1-"));
    const node = createStorageNode({ storageDir: dir, identity, registry });
    const port = await node.listen(0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.baseUrl).toBe(baseUrl);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("2. registry contains correct node record", async () => {
    const registry = createRegistry();
    const identity = createIdentity();
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg011-2-"));
    const node = createStorageNode({ storageDir: dir, identity, registry });
    await node.listen(0, "127.0.0.1");
    const rec = registry.get(identity.publicKey.toString("base64"));
    expect(rec).toBeDefined();
    expect(rec?.publicKey).toBe(identity.publicKey.toString("base64"));
    expect(rec?.nodeId).toBe(identity.publicKey.toString("base64"));
    expect(rec?.available).toBe(true);
    expect(typeof rec?.lastSeen).toBe("number");
    // Private key not stored
    expect((rec as unknown as Record<string, unknown>)["privateKey"]).toBeUndefined();
    const json = JSON.stringify(rec);
    expect(json).not.toContain(identity.privateKey.toString("base64"));
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("3. heartbeat updates node availability", async () => {
    const registry = createRegistry({ heartbeatTimeoutMs: 200 });
    const identity = createIdentity();
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg011-3-"));
    const node = createStorageNode({
      storageDir: dir,
      identity,
      registry,
      registryHeartbeatIntervalMs: 50,
    });
    await node.listen(0, "127.0.0.1");
    const firstSeen = registry.get(identity.publicKey.toString("base64"))?.lastSeen as number;
    // Wait for at least one heartbeat
    await new Promise((r) => setTimeout(r, 120));
    const secondSeen = registry.get(identity.publicKey.toString("base64"))?.lastSeen as number;
    expect(secondSeen).toBeGreaterThan(firstSeen);
    expect(registry.listAvailable()).toHaveLength(1);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("4. graceful close unregisters node", async () => {
    const registry = createRegistry();
    const identity = createIdentity();
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg011-4-"));
    const node = createStorageNode({ storageDir: dir, identity, registry });
    await node.listen(0, "127.0.0.1");
    expect(registry.list()).toHaveLength(1);
    await node.close();
    expect(registry.list()).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("5. client discovers registered available nodes", async () => {
    const registry = createRegistry();
    const ids = [createIdentity(), createIdentity()];
    const dirs = await Promise.all(ids.map(() => mkdtemp(join(tmpdir(), "openstore-reg011-5-"))));
    const nodes = await Promise.all(
      ids.map((id, i) => {
        const n = createStorageNode({ storageDir: dirs[i] as string, identity: id, registry });
        return n.listen(0, "127.0.0.1").then(() => n);
      }),
    );
    const discovered = discoverAvailableEndpoints(registry);
    expect(discovered).toHaveLength(2);
    for (const ep of discovered) {
      expect(typeof ep.id).toBe("string");
      expect(typeof ep.baseUrl).toBe("string");
      expect(ep.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    }
    // Verify discovered endpoints can be used with client store
    const { storePieceOnNodes } = await import("../client/index.js");
    const endpoints: StorageNodeEndpoint[] = discovered;
    const report = await storePieceOnNodes("disc-test-piece", Buffer.from("via-discovery"), endpoints);
    expect(report.succeeded.length).toBe(2);
    for (const n of nodes) await n.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("6. unavailable/expired nodes are excluded", async () => {
    const registry = createRegistry({ heartbeatTimeoutMs: 80 });
    const idAvailable = createIdentity();
    const idExpired = createIdentity();
    // Manually register both without heartbeat
    registry.register("http://127.0.0.1:5001", idAvailable);
    registry.register("http://127.0.0.1:5002", idExpired);
    expect(registry.listAvailable()).toHaveLength(2);
    // Wait for expiration
    await new Promise((r) => setTimeout(r, 120));
    const available = registry.listAvailable();
    expect(available).toHaveLength(0);
    // Heartbeat one to revive
    registry.heartbeat(idAvailable.publicKey.toString("base64"), idAvailable);
    expect(registry.listAvailable()).toHaveLength(1);
    expect(registry.listAvailable()[0]?.nodeId).toBe(idAvailable.publicKey.toString("base64"));
    // discover excludes expired
    expect(discoverAvailableEndpoints(registry)).toHaveLength(1);
  });

  it("7. registry failure does not expose private keys", async () => {
    const registry = createRegistry();
    const identity = createIdentity();
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg011-7-"));
    // Simulate registry failure by using a registry that throws
    const failingRegistry = {
      ...registry,
      registerSigned: () => {
        throw new Error("registry down");
      },
      heartbeatSigned: () => {
        throw new Error("heartbeat failed");
      },
      unregisterSigned: () => {
        throw new Error("unregister failed");
      },
    } as unknown as typeof registry;

    const node = createStorageNode({ storageDir: dir, identity, registry: failingRegistry });
    let errMsg = "";
    try {
      await node.listen(0, "127.0.0.1");
    } catch (err) {
      errMsg = (err as Error).message;
    }
    expect(errMsg).toMatch(/registry registration failed/i);
    expect(errMsg).not.toContain(identity.privateKey.toString("base64"));
    expect(errMsg).not.toContain(identity.privateKey.toString("hex"));
    // Ensure node closed after failure (server not leaking)
    try {
      await node.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  it("8. manual endpoints still work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg011-8-"));
    const node = createStorageNode({ storageDir: dir });
    const port = await node.listen(0, "127.0.0.1");
    const manual: StorageNodeEndpoint = { id: "manual-011", baseUrl: `http://127.0.0.1:${port}` };
    const { storePieceOnNodes, getPieceFromNodes } = await import("../client/index.js");
    const data = Buffer.from("manual-still-works-011");
    const report = await storePieceOnNodes("manual-011-piece", data, [manual]);
    expect(report.succeeded).toHaveLength(1);
    const got = await getPieceFromNodes("manual-011-piece", [manual]);
    expect(got.bytes.equals(data)).toBe(true);
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("9. mergeEndpoints keeps manual and discovered", async () => {
    const registry = createRegistry();
    const id = createIdentity();
    const dir = await mkdtemp(join(tmpdir(), "openstore-reg011-9-"));
    const node = createStorageNode({ storageDir: dir, identity: id, registry });
    await node.listen(0, "127.0.0.1");
    const manual: StorageNodeEndpoint[] = [{ id: "manual-extra", baseUrl: "http://127.0.0.1:6000" }];
    const merged = mergeEndpoints(manual, discoverAvailableEndpoints(registry));
    expect(merged).toHaveLength(2);
    expect(merged[0]?.id).toBe("manual-extra");
    expect(merged[1]?.id).toBe(id.publicKey.toString("base64"));
    await node.close();
    await rm(dir, { recursive: true, force: true });
  });
});
