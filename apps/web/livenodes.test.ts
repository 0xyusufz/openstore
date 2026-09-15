/**
 * Live Node Integration Tests (OPENSTORE-028 follow-up)
 *
 * Proves the Live web app uses REAL storage node instances sharing the
 * web backend's registry — and never silently falls back to demo node
 * data when a registry is configured.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { createWebBackend } from "./backend.js";
import { createWebServer } from "./server.js";
import { parseCsvList, parseStorageCapacityBytes, parseStoragePorts } from "./server.js";

interface LiveNode {
  node: StorageNode;
  dir: string;
  baseUrl: string;
  nodeId: string;
}

async function startLiveNode(
  registry: ReturnType<typeof createRegistry>,
): Promise<LiveNode> {
  const dir = await mkdtemp(join(tmpdir(), "openstore-live-node-"));
  const identity = createIdentity();
  const node = createStorageNode({
    storageDir: dir,
    identity,
    registry,
    registryHeartbeatIntervalMs: 50,
  });
  const port = await node.listen(0, "127.0.0.1");
  return { node, dir, baseUrl: `http://127.0.0.1:${port}`, nodeId: identity.publicKey.toString("base64") };
}

async function stopLiveNode(n: LiveNode): Promise<void> {
  try { await n.node.close(); } catch {}
  await rm(n.dir, { recursive: true, force: true });
}

function uploadFile(port: number, filename: string, data: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  const boundary = "live-boundary-1";
  const header = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header, "utf8"), data, Buffer.from(footer, "utf8")]);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/api/files/upload", method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("live node integration", () => {
  it("1. live registry nodes appear in the snapshot, never demo nodes", async () => {
    const manifestDir = await mkdtemp(join(tmpdir(), "openstore-live-manifests-"));
    const registry = createRegistry();
    const n1 = await startLiveNode(registry);
    const n2 = await startLiveNode(registry);
    const web = createWebServer({ manifestDir, registry });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const nodesJson = (await (await fetch(`${base}/api/nodes`)).json()) as {
        nodes: { id: string; baseUrl: string }[];
        source: string;
      };
      expect(nodesJson.source).toBe("live");
      expect(nodesJson.nodes).toHaveLength(2);
      const ids = nodesJson.nodes.map((n) => n.id).sort();
      expect(ids).toEqual([n1.nodeId, n2.nodeId].sort());
      const urls = nodesJson.nodes.map((n) => n.baseUrl).sort();
      expect(urls).toEqual([n1.baseUrl, n2.baseUrl].sort());
      // No demo data anywhere in the live payload.
      expect(JSON.stringify(nodesJson).toLowerCase()).not.toContain("demo");
      const health = (await (await fetch(`${base}/health`)).json()) as { demoMode: boolean };
      expect(health.demoMode).toBe(false);
    } finally {
      await web.close();
      await stopLiveNode(n1);
      await stopLiveNode(n2);
      await rm(manifestDir, { recursive: true, force: true });
      await rm(`${manifestDir}.deks.json`, { force: true });
    }
  });

  it("2. upload and download succeed through live nodes end-to-end", async () => {
    const manifestDir = await mkdtemp(join(tmpdir(), "openstore-live-e2e-"));
    const registry = createRegistry();
    const n1 = await startLiveNode(registry);
    const n2 = await startLiveNode(registry);
    const web = createWebServer({ manifestDir, registry });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const fileData = Buffer.concat([randomBytes(1024), Buffer.from([0x00, 0xff, 0x0d, 0x0a])]);
      const uploaded = await uploadFile(port, "live.bin", fileData);
      expect(uploaded.status).toBe(200);
      const fileId = uploaded.json["fileId"] as string;

      const files = (await (await fetch(`${base}/api/files`)).json()) as {
        files: { fileId: string }[];
        source: string;
      };
      expect(files.source).toBe("live");
      expect(files.files.map((f) => f.fileId)).toContain(fileId);

      const dl = await fetch(`${base}/api/files/${fileId}/download`);
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).equals(fileData)).toBe(true);
    } finally {
      await web.close();
      await stopLiveNode(n1);
      await stopLiveNode(n2);
      await rm(manifestDir, { recursive: true, force: true });
      await rm(`${manifestDir}.deks.json`, { force: true });
    }
  });

  it("3. configured-but-empty registry stays live, never demo", async () => {
    const manifestDir = await mkdtemp(join(tmpdir(), "openstore-live-empty-"));
    const registry = createRegistry();
    const web = createWebServer({ manifestDir, registry });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const nodesJson = (await (await fetch(`${base}/api/nodes`)).json()) as {
        nodes: unknown[];
        source: string;
      };
      expect(nodesJson.source).toBe("live");
      expect(nodesJson.nodes).toEqual([]);
      // Upload fails honestly instead of using demo nodes.
      const failed = await uploadFile(port, "nope.bin", Buffer.alloc(32, 1));
      expect(failed.status).toBe(500);
      expect(String(failed.json["error"])).toMatch(/no storage nodes/i);
    } finally {
      await web.close();
      await rm(manifestDir, { recursive: true, force: true });
      await rm(`${manifestDir}.deks.json`, { force: true });
    }
  });

  it("4. heartbeat-expired nodes are excluded from selection but shown offline", async () => {
    const manifestDir = await mkdtemp(join(tmpdir(), "openstore-live-expiry-"));
    try {
      const registry = createRegistry({ heartbeatTimeoutMs: 60 });
      const identity = createIdentity();
      registry.register("http://127.0.0.1:9", identity, { allocatedBytes: 1000, usedBytes: 0, availableBytes: 1000 });
      // Let the heartbeat expire without any follow-up heartbeat.
      await new Promise((r) => setTimeout(r, 150));

      const backend = createWebBackend({ manifestDir, registry });
      await expect(backend.uploadFile("stale.bin", Buffer.alloc(32, 2))).rejects.toThrow(/no storage nodes/i);

      // The snapshot still lists the node, honestly marked unavailable.
      const snapshot = await backend.getSnapshot();
      expect(snapshot.nodesSource).toBe("live");
      expect(snapshot.nodes).toHaveLength(1);
      expect(snapshot.nodes[0]!.available).toBe(false);
    } finally {
      await rm(manifestDir, { recursive: true, force: true });
      await rm(`${manifestDir}.deks.json`, { force: true });
    }
  });

  it("5. demo mode remains the explicit zero-config default", async () => {
    const web = createWebServer();
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const nodesJson = (await (await fetch(`${base}/api/nodes`)).json()) as { source: string };
      expect(nodesJson.source).toBe("demo");
      const filesJson = (await (await fetch(`${base}/api/files`)).json()) as { source: string };
      expect(filesJson.source).toBe("demo");
    } finally {
      await web.close();
    }
  });

  it("6. standalone env parsing is strict and predictable", () => {
    expect(parseCsvList(undefined)).toEqual([]);
    expect(parseCsvList("")).toEqual([]);
    expect(parseCsvList("  ")).toEqual([]);
    expect(parseCsvList("a,b , c")).toEqual(["a", "b", "c"]);
    expect(parseCsvList("./data/n1,./data/n2")).toEqual(["./data/n1", "./data/n2"]);

    expect(parseStoragePorts(undefined, 2)).toEqual([0, 0]);
    expect(parseStoragePorts("", 1)).toEqual([0]);
    expect(parseStoragePorts("4101,4102", 2)).toEqual([4101, 4102]);
    expect(() => parseStoragePorts("4101", 2)).toThrow(/has 1 entries but.*has 2/i);
    expect(() => parseStoragePorts("abc,4102", 2)).toThrow(/invalid storage node port/i);
    expect(() => parseStoragePorts("0,4102", 2)).toThrow(/invalid storage node port/i);
    expect(() => parseStoragePorts("70000", 1)).toThrow(/invalid storage node port/i);

    expect(parseStorageCapacityBytes(undefined)).toBeUndefined();
    expect(parseStorageCapacityBytes("")).toBeUndefined();
    expect(parseStorageCapacityBytes("1073741824")).toBe(1073741824);
    expect(() => parseStorageCapacityBytes("0")).toThrow(/invalid/i);
    expect(() => parseStorageCapacityBytes("-5")).toThrow(/invalid/i);
    expect(() => parseStorageCapacityBytes("big")).toThrow(/invalid/i);
  });
});
