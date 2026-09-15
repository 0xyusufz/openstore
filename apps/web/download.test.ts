/**
 * Real Encrypted Web Download Tests (OPENSTORE-028)
 *
 * End-to-end tests using real storage nodes, the real encrypted upload
 * pipeline, the download pipeline from `apps/client/download.ts`, and
 * real HTTP requests. No mocking.
 *
 * Coverage:
 *  1. uploaded text file downloads byte-exactly
 *  2. random binary file downloads byte-exactly
 *  3. multi-chunk file downloads correctly
 *  4. exact 4 MiB boundary works
 *  5. replica fallback works
 *  6. corrupt piece is rejected and healthy replica succeeds
 *  7. all replicas unavailable fails safely
 *  8. wrong/missing DEK fails closed
 *  9. corrupt-everywhere fails closed (size/hash/order validation)
 * 10. safe filename handling
 * 11. no secret leakage/persistence
 * 12. duplicate download prevention
 * 13. DEMO mode remains honest
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { DEFAULT_CHUNK_SIZE } from "../../packages/chunking/index.js";
import { createIdentity } from "../../packages/identity/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createDekStore } from "./dekstore.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { uploadBuffer } from "../client/upload.js";
import { createWebServer } from "./server.js";

interface TestNode {
  id: string;
  baseUrl: string;
  node: StorageNode;
  dir: string;
}

let nodes: TestNode[] = [];
let registryNodes: { nodeId: string; baseUrl: string }[] = [];
let manifestDir = "";

beforeAll(async () => {
  const dir1 = await mkdtemp(join(tmpdir(), "openstore-dl-node1-"));
  const dir2 = await mkdtemp(join(tmpdir(), "openstore-dl-node2-"));
  const dir3 = await mkdtemp(join(tmpdir(), "openstore-dl-node3-"));

  const node1 = createStorageNode({ storageDir: dir1 });
  const node2 = createStorageNode({ storageDir: dir2 });
  const node3 = createStorageNode({ storageDir: dir3 });

  const port1 = await node1.listen(0, "127.0.0.1");
  const port2 = await node2.listen(0, "127.0.0.1");
  const port3 = await node3.listen(0, "127.0.0.1");

  const identity1 = createIdentity();
  const identity2 = createIdentity();
  const identity3 = createIdentity();

  const registry = createRegistry();
  const id1 = identity1.publicKey.toString("base64");
  const id2 = identity2.publicKey.toString("base64");
  const id3 = identity3.publicKey.toString("base64");

  registry.register(`http://127.0.0.1:${port1}`, identity1, { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
  registry.register(`http://127.0.0.1:${port2}`, identity2, { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
  registry.register(`http://127.0.0.1:${port3}`, identity3, { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });

  nodes = [
    { id: id1, baseUrl: `http://127.0.0.1:${port1}`, node: node1, dir: dir1 },
    { id: id2, baseUrl: `http://127.0.0.1:${port2}`, node: node2, dir: dir2 },
    { id: id3, baseUrl: `http://127.0.0.1:${port3}`, node: node3, dir: dir3 },
  ];
  registryNodes = [
    { nodeId: id1, baseUrl: `http://127.0.0.1:${port1}` },
    { nodeId: id2, baseUrl: `http://127.0.0.1:${port2}` },
    { nodeId: id3, baseUrl: `http://127.0.0.1:${port3}` },
  ];
  manifestDir = await mkdtemp(join(tmpdir(), "openstore-dl-manifests-"));
}, 30_000);

afterAll(async () => {
  for (const n of nodes) {
    await n.node.close();
    await rm(n.dir, { recursive: true, force: true });
  }
  if (manifestDir) {
    await rm(manifestDir, { recursive: true, force: true });
    await rm(`${manifestDir}.deks.json`, { force: true });
  }
});

function buildMultipartBody(filename: string, fileData: Buffer): Buffer {
  const boundary = "test-dl-boundary-789";
  const header = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(header, "utf8"), fileData, Buffer.from(footer, "utf8")]);
}

function uploadFile(port: number, filename: string, data: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  const boundary = "test-dl-boundary-789";
  const body = buildMultipartBody(filename, data);
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

interface DownloadResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

async function downloadFile(port: number, fileId: string): Promise<DownloadResponse> {
  const res = await fetch(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(fileId)}/download`);
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

async function errorJson(port: number, fileId: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(fileId)}/download`);
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch {}
  return { status: res.status, json };
}

function makeWebRegistry(): ReturnType<typeof createRegistry> {
  const reg = createRegistry();
  for (const n of registryNodes) {
    const ident = createIdentity();
    reg.register(n.baseUrl, ident, { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
  }
  return reg;
}

const SECRET_WORDS = ["privatekey", "recoveryphrase", "encryptionkey", "password", "mnemonic"];

describe("real encrypted web download (OPENSTORE-028)", () => {
  it("1. uploaded text file downloads byte-exactly", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.from("hello download — text with unicode ☃ and trailing newline\n", "utf8");
      const uploaded = await uploadFile(port, "hello-dl.txt", fileData);
      expect(uploaded.status).toBe(200);
      const fileId = uploaded.json["fileId"] as string;

      const dl = await downloadFile(port, fileId);
      expect(dl.status).toBe(200);
      expect(dl.body.equals(fileData)).toBe(true);
      expect(dl.headers.get("content-type")).toContain("application/octet-stream");
      expect(dl.headers.get("content-length")).toBe(String(fileData.length));
      expect(dl.headers.get("content-disposition")).toContain('filename="hello-dl.txt"');
      expect(dl.headers.get("cache-control")).toContain("no-store");
    } finally {
      await web.close();
    }
  });

  it("2. random binary file downloads byte-exactly", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      // NULs, CRLFs, high bytes, and multipart-boundary-like ASCII.
      // The fixed 0x41 byte before the marker keeps the test
      // deterministic: the marker is never framed by CRLF, so only a
      // correct delimiter-framed parser preserves it.
      const fileData = Buffer.concat([
        randomBytes(2048),
        Buffer.from([0x41]),
        Buffer.from("--test-dl-boundary-789\r\n\r\nfake-part", "utf8"),
        Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x00]),
        randomBytes(1024),
      ]);
      const uploaded = await uploadFile(port, "random-dl.bin", fileData);
      expect(uploaded.status).toBe(200);
      const dl = await downloadFile(port, uploaded.json["fileId"] as string);
      expect(dl.status).toBe(200);
      expect(dl.body.equals(fileData)).toBe(true);
    } finally {
      await web.close();
    }
  });

  it("3. multi-chunk file downloads correctly", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = randomBytes(DEFAULT_CHUNK_SIZE + 2048);
      const uploaded = await uploadFile(port, "multi-dl.bin", fileData);
      expect(uploaded.status).toBe(200);
      expect(uploaded.json["totalChunks"]).toBe(2);
      const dl = await downloadFile(port, uploaded.json["fileId"] as string);
      expect(dl.status).toBe(200);
      expect(dl.body.length).toBe(fileData.length);
      expect(dl.body.equals(fileData)).toBe(true);
    } finally {
      await web.close();
    }
  }, 30_000);

  it("4. exact 4 MiB boundary works", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = randomBytes(DEFAULT_CHUNK_SIZE);
      const uploaded = await uploadFile(port, "boundary-dl.bin", fileData);
      expect(uploaded.status).toBe(200);
      expect(uploaded.json["totalChunks"]).toBe(1);
      const dl = await downloadFile(port, uploaded.json["fileId"] as string);
      expect(dl.status).toBe(200);
      expect(dl.body.equals(fileData)).toBe(true);
    } finally {
      await web.close();
    }
  }, 30_000);

  it("5. replica fallback works when one node is unavailable", async () => {
    const freshManifestDir = await mkdtemp(join(tmpdir(), "openstore-dl-fallback-"));
    const fresh: { node: StorageNode; dir: string; baseUrl: string }[] = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        const dir = await mkdtemp(join(tmpdir(), "openstore-dl-fb-node-"));
        const node = createStorageNode({ storageDir: dir });
        const port = await node.listen(0, "127.0.0.1");
        fresh.push({ node, dir, baseUrl: `http://127.0.0.1:${port}` });
      }
      const reg = createRegistry();
      for (const n of fresh) {
        reg.register(n.baseUrl, createIdentity(), { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
      }
      const web = createWebServer({ manifestDir: freshManifestDir, registry: reg });
      const port = await web.listen(0, "127.0.0.1");
      try {
        const fileData = randomBytes(2048);
        const uploaded = await uploadFile(port, "fallback.bin", fileData);
        expect(uploaded.status).toBe(200);
        const fileId = uploaded.json["fileId"] as string;
        // Kill one replica entirely; the survivor must serve the download.
        await fresh[1]!.node.close();
        const dl = await downloadFile(port, fileId);
        expect(dl.status).toBe(200);
        expect(dl.body.equals(fileData)).toBe(true);
      } finally {
        await web.close();
      }
    } finally {
      for (const n of fresh) {
        try { await n.node.close(); } catch {}
        await rm(n.dir, { recursive: true, force: true });
      }
      await rm(freshManifestDir, { recursive: true, force: true });
      await rm(`${freshManifestDir}.deks.json`, { force: true });
    }
  });

  it("6. corrupt piece is rejected and healthy replica succeeds", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = randomBytes(1024);
      const uploaded = await uploadFile(port, "corrupt-one.bin", fileData);
      expect(uploaded.status).toBe(200);
      const fileId = uploaded.json["fileId"] as string;
      const store = createManifestStore({ dir: manifestDir });
      const manifest = await store.load(fileId);
      expect(manifest).toBeDefined();
      // Poison one replica's copy of the first piece; rotation must route
      // around it to a healthy replica instead of failing.
      await writeFile(join(nodes[0]!.dir, manifest!.pieceIds[0] as string), Buffer.from("corrupted-by-test"));
      const dl = await downloadFile(port, fileId);
      expect(dl.status).toBe(200);
      expect(dl.body.equals(fileData)).toBe(true);
    } finally {
      await web.close();
    }
  });

  it("7. all replicas unavailable fails safely", async () => {
    const freshManifestDir = await mkdtemp(join(tmpdir(), "openstore-dl-dead-"));
    const fresh: { node: StorageNode; dir: string; baseUrl: string }[] = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        const dir = await mkdtemp(join(tmpdir(), "openstore-dl-dead-node-"));
        const node = createStorageNode({ storageDir: dir });
        const port = await node.listen(0, "127.0.0.1");
        fresh.push({ node, dir, baseUrl: `http://127.0.0.1:${port}` });
      }
      const reg = createRegistry();
      for (const n of fresh) {
        reg.register(n.baseUrl, createIdentity(), { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
      }
      const web = createWebServer({ manifestDir: freshManifestDir, registry: reg });
      const port = await web.listen(0, "127.0.0.1");
      try {
        const uploaded = await uploadFile(port, "doomed.bin", randomBytes(512));
        expect(uploaded.status).toBe(200);
        const fileId = uploaded.json["fileId"] as string;
        for (const n of fresh) await n.node.close();
        const { status, json } = await errorJson(port, fileId);
        expect(status).toBe(500);
        expect(Object.keys(json)).toEqual(["error"]);
        const text = JSON.stringify(json).toLowerCase();
        for (const word of SECRET_WORDS) expect(text).not.toContain(word);
      } finally {
        await web.close();
      }
    } finally {
      for (const n of fresh) {
        try { await n.node.close(); } catch {}
        await rm(n.dir, { recursive: true, force: true });
      }
      await rm(freshManifestDir, { recursive: true, force: true });
      await rm(`${freshManifestDir}.deks.json`, { force: true });
    }
  });

  it("8. wrong/missing DEK fails closed", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      // Missing DEK: manifest persisted directly, bypassing the vault.
      const store = createManifestStore({ dir: manifestDir });
      const endpoints = nodes.map((n) => ({ id: n.id, baseUrl: n.baseUrl }));
      const direct = await uploadBuffer(randomBytes(256), "direct.bin", endpoints, { manifestStore: store });
      const missing = await errorJson(port, direct.manifest.fileId);
      expect(missing.status).toBe(404);
      expect(String(missing.json["error"])).toMatch(/key unavailable/i);

      // Wrong DEK: overwrite the vault entry, then restore the true key.
      const fileData = randomBytes(256);
      const uploaded = await uploadFile(port, "rekeyed.bin", fileData);
      expect(uploaded.status).toBe(200);
      const fileId = uploaded.json["fileId"] as string;
      const vault = createDekStore({ path: `${manifestDir}.deks.json` });
      await vault.saveDek(fileId, randomBytes(32));
      const wrong = await errorJson(port, fileId);
      expect(wrong.status).toBe(500);
      expect(Object.keys(wrong.json)).toEqual(["error"]);
      await vault.saveDek(fileId, Buffer.from(direct.encryptionKey));
      direct.encryptionKey.fill(0);
      // Cleanup the direct-upload manifest so later catalog assertions stay exact.
      await store.delete(direct.manifest.fileId);
    } finally {
      await web.close();
    }
  });

  it("9. corrupt-everywhere fails closed instead of returning bad bytes", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = randomBytes(512);
      const uploaded = await uploadFile(port, "corrupt-all.bin", fileData);
      expect(uploaded.status).toBe(200);
      const fileId = uploaded.json["fileId"] as string;
      const store = createManifestStore({ dir: manifestDir });
      const manifest = await store.load(fileId);
      expect(manifest).toBeDefined();
      for (const pieceId of manifest!.pieceIds) {
        for (const node of nodes) {
          await writeFile(join(node.dir, pieceId), Buffer.from("garbage-everywhere"));
        }
      }
      const { status, json } = await errorJson(port, fileId);
      expect(status).toBe(500);
      expect(Object.keys(json)).toEqual(["error"]);
    } finally {
      await web.close();
    }
  });

  it("10. download filename is header-safe", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const uploaded = await uploadFile(port, "../../evil.txt", Buffer.alloc(64, 0x41));
      expect(uploaded.status).toBe(200);
      const dl = await downloadFile(port, uploaded.json["fileId"] as string);
      expect(dl.status).toBe(200);
      const disposition = dl.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("attachment");
      const name = (disposition.match(/filename="([^"]*)"/) ?? [])[1] ?? "";
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain("..");
      expect(name).not.toContain("\r");
      expect(name).not.toContain("\n");

      const spaced = await uploadFile(port, "my report (final).txt", Buffer.alloc(32, 0x42));
      expect(spaced.status).toBe(200);
      const dlSpaced = await downloadFile(port, spaced.json["fileId"] as string);
      expect(dlSpaced.headers.get("content-disposition")).toContain('filename="my report (final).txt"');

      // Unknown and malformed IDs are rejected without touching storage.
      const missing = await errorJson(port, "0123456789abcdef0123456789abcdef");
      expect(missing.status).toBe(404);
      const badRes = await fetch(`http://127.0.0.1:${port}/api/files/..%2F..%2Fx/download`);
      expect([400, 404]).toContain(badRes.status);
    } finally {
      await web.close();
    }
  });

  it("11. no secret leakage or persistence anywhere in the flow", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const marker = `dl-secret-${randomBytes(8).toString("hex")}`;
      const fileData = Buffer.from(`prefix-${marker}-suffix`);
      const uploaded = await uploadFile(port, "secret-dl.bin", fileData);
      expect(uploaded.status).toBe(200);
      const fileId = uploaded.json["fileId"] as string;

      // Success path: headers carry metadata only; body is the owner's file.
      const dl = await downloadFile(port, fileId);
      expect(dl.status).toBe(200);
      expect(dl.body.equals(fileData)).toBe(true);
      const headerText = [...dl.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n").toLowerCase();
      for (const word of SECRET_WORDS) expect(headerText).not.toContain(word);
      expect(headerText).not.toContain("dek");

      // Error paths are minimal JSON with no secret words.
      const { json } = await errorJson(port, "0123456789abcdef0123456789abcdef");
      const errText = JSON.stringify(json).toLowerCase();
      for (const word of SECRET_WORDS) expect(errText).not.toContain(word);

      // The vault on disk holds key material only: no file plaintext, 0600.
      const vaultBytes = await readFile(`${manifestDir}.deks.json`, "utf8");
      expect(vaultBytes).not.toContain(marker);
      expect(vaultBytes.toLowerCase()).not.toContain("password");
      expect(vaultBytes.toLowerCase()).not.toContain("recoveryphrase");
      expect((await stat(`${manifestDir}.deks.json`)).mode & 0o777).toBe(0o600);

      // Manifests on disk hold metadata only.
      const manifestText = await readFile(join(manifestDir, `${fileId}.json`), "utf8");
      expect(manifestText).not.toContain(marker);
      for (const word of SECRET_WORDS) expect(manifestText.toLowerCase()).not.toContain(word);
    } finally {
      await web.close();
    }
  });

  it("12. duplicate downloads are prevented while one is active", async () => {
    const { attemptDownload, createInitialState, downloadComplete, downloadFailed } = await import("./src/store.js");
    const fileId = "0123456789abcdef0123456789abcdef";
    let state = { ...createInitialState(), files: [{ fileId, filename: "dup.bin", size: 8, totalChunks: 1, chunkSize: 8 }] };
    state = attemptDownload(state, fileId);
    expect(state.download.status).toBe("active");
    // Second attempt while active: identical state, no duplicate fetch.
    expect(attemptDownload(state, fileId)).toBe(state);
    // Finished flows accept a fresh download.
    const done = downloadComplete(state, { fileId, filename: "dup.bin", size: 8 });
    expect(done.download.status).toBe("complete");
    expect(attemptDownload(done, fileId).download.status).toBe("active");
    const failed = downloadFailed(state, "boom");
    expect(failed.download.status).toBe("failed");
    expect(attemptDownload(failed, fileId).download.status).toBe("active");
  });

  it("13. DEMO mode remains honest", async () => {
    const web = createWebServer({});
    const port = await web.listen(0, "127.0.0.1");
    try {
      const { status, json } = await errorJson(port, "0123456789abcdef0123456789abcdef");
      expect(status).toBe(500);
      expect(typeof json["error"]).toBe("string");
      // No file bytes, no success shape.
      const res = await fetch(`http://127.0.0.1:${port}/api/files/0123456789abcdef0123456789abcdef/download`);
      expect(res.headers.get("content-type")).toContain("application/json");
    } finally {
      await web.close();
    }
  });
});
