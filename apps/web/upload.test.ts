/**
 * Real Encrypted Web Upload Tests (OPENSTORE-027)
 *
 * End-to-end tests using real storage nodes, the real encrypted upload
 * pipeline (deterministic chunks → per-file random DEK → per-chunk
 * AES-256-GCM with fresh IV → replicated nodes → persisted manifest),
 * and real HTTP multipart requests. No mocking.
 *
 * Coverage:
 *  1. small text file
 *  2. binary/random file
 *  3. file larger than one 4 MiB chunk
 *  4. exact chunk-boundary file
 *  5. empty file rejection
 *  6. filename/path traversal safety
 *  7. plaintext absent from stored pieces
 *  8. encrypted pieces decrypt correctly through the download pipeline
 *  9. replication and partial node failure
 * 10. capacity failure
 * 11. failed upload does not create catalog entry
 * 12. no secret leakage
 */

import { mkdtemp, readdir, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { DEFAULT_CHUNK_SIZE } from "../../packages/chunking/index.js";
import { createIdentity } from "../../packages/identity/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { uploadBuffer } from "../client/upload.js";
import { downloadBuffer } from "../client/download.js";
import type { StorageNodeEndpoint } from "../client/index.js";
import { MAX_UPLOAD_BYTES, createWebBackend } from "./backend.js";
import { createWebServer } from "./server.js";
import type { WebServer } from "./server.js";

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
  const dir1 = await mkdtemp(join(tmpdir(), "openstore-upload-node1-"));
  const dir2 = await mkdtemp(join(tmpdir(), "openstore-upload-node2-"));
  const dir3 = await mkdtemp(join(tmpdir(), "openstore-upload-node3-"));

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
  manifestDir = await mkdtemp(join(tmpdir(), "openstore-upload-manifests-"));
}, 30_000);

afterAll(async () => {
  for (const n of nodes) {
    await n.node.close();
    await rm(n.dir, { recursive: true, force: true });
  }
  if (manifestDir) {
    await rm(manifestDir, { recursive: true, force: true });
    // The DEK vault is a sibling file, invisible to the manifest catalog.
    await rm(`${manifestDir}.deks.json`, { force: true });
  }
});

function buildMultipartBody(filename: string, fileData: Buffer): Buffer {
  const boundary = "test-boundary-abc123";
  const header = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(header, "utf8"), fileData, Buffer.from(footer, "utf8")]);
}

function uploadFile(port: number, filename: string, data: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  const boundary = "test-boundary-abc123";
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

function makeWebRegistry(): ReturnType<typeof createRegistry> {
  const reg = createRegistry();
  for (const n of registryNodes) {
    const ident = createIdentity();
    reg.register(n.baseUrl, ident, { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
  }
  return reg;
}

function liveEndpoints(): StorageNodeEndpoint[] {
  return nodes.map((n) => ({ id: n.id, baseUrl: n.baseUrl }));
}

async function catalogFileIds(port: number): Promise<string[]> {
  const filesRes = await fetch(`http://127.0.0.1:${port}/api/files`);
  const filesJson = (await filesRes.json()) as { files: Array<{ fileId: string }> };
  return filesJson.files.map((f) => f.fileId);
}

/** Raw stored piece bytes across all shared test nodes. */
async function readAllStoredPieces(): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const node of nodes) {
    let files: string[] = [];
    try {
      files = await readdir(node.dir);
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        out.push(await readFile(join(node.dir, f)));
      } catch {}
    }
  }
  return out;
}

describe("real web file upload (OPENSTORE-026, hardened OPENSTORE-027)", () => {
  it("1. real file upload succeeds end-to-end", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.alloc(512, 0x42);
      const { status, json } = await uploadFile(port, "test-upload.bin", fileData);
      expect(status).toBe(200);
      expect(typeof json["fileId"]).toBe("string");
      expect(json["filename"]).toBe("test-upload.bin");
      expect(json["size"]).toBe(512);
      expect(typeof json["totalChunks"]).toBe("number");
      expect((json["totalChunks"] as number) >= 1).toBe(true);
      // Response carries safe metadata only — exact key set.
      expect(Object.keys(json).sort()).toEqual(["fileId", "filename", "size", "totalChunks"]);
    } finally {
      await web.close();
    }
  });

  it("2. small text file round-trips byte-identical through the pipeline", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.from("hello openstore — small text file ☃\nsecond line\n", "utf8");
      const { status, json } = await uploadFile(port, "hello.txt", fileData);
      expect(status).toBe(200);
      expect(json["size"]).toBe(fileData.length);
      expect(json["totalChunks"]).toBe(1);

      // Same pipeline, direct handle: upload → download must be identical.
      const { manifest, encryptionKey } = await uploadBuffer(fileData, "hello.txt", liveEndpoints(), {
        manifestStore: createManifestStore({ dir: manifestDir }),
      });
      try {
        const roundTripped = await downloadBuffer(manifest, encryptionKey, liveEndpoints());
        expect(roundTripped.equals(fileData)).toBe(true);
      } finally {
        encryptionKey.fill(0);
      }
    } finally {
      await web.close();
    }
  });

  it("3. binary/random file uploads without corruption", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      // Random bytes cover NULs, CRLF sequences, boundary-like ASCII, and high bytes.
      const fileData = randomBytes(4096);
      const { status, json } = await uploadFile(port, "random.bin", fileData);
      expect(status).toBe(200);
      expect(json["size"]).toBe(4096);
      expect(json["totalChunks"]).toBe(1);

      const { manifest, encryptionKey } = await uploadBuffer(fileData, "random.bin", liveEndpoints(), {
        manifestStore: createManifestStore({ dir: manifestDir }),
      });
      try {
        const roundTripped = await downloadBuffer(manifest, encryptionKey, liveEndpoints());
        expect(roundTripped.equals(fileData)).toBe(true);
      } finally {
        encryptionKey.fill(0);
      }
    } finally {
      await web.close();
    }
  });

  it("4. file larger than one 4 MiB chunk splits into multiple chunks", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = randomBytes(DEFAULT_CHUNK_SIZE + 1024);
      const { status, json } = await uploadFile(port, "multi-chunk.bin", fileData);
      expect(status).toBe(200);
      expect(json["size"]).toBe(fileData.length);
      expect(json["totalChunks"]).toBe(2);

      const { manifest, encryptionKey } = await uploadBuffer(fileData, "multi-chunk.bin", liveEndpoints(), {
        manifestStore: createManifestStore({ dir: manifestDir }),
      });
      try {
        expect(manifest.totalChunks).toBe(2);
        const roundTripped = await downloadBuffer(manifest, encryptionKey, liveEndpoints());
        expect(roundTripped.equals(fileData)).toBe(true);
      } finally {
        encryptionKey.fill(0);
      }
    } finally {
      await web.close();
    }
  }, 30_000);

  it("5. exact chunk-boundary file stays a single chunk", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = randomBytes(DEFAULT_CHUNK_SIZE);
      const { status, json } = await uploadFile(port, "boundary.bin", fileData);
      expect(status).toBe(200);
      expect(json["size"]).toBe(DEFAULT_CHUNK_SIZE);
      expect(json["totalChunks"]).toBe(1);
    } finally {
      await web.close();
    }
  }, 30_000);

  it("6. empty file is rejected safely at every layer", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const before = await catalogFileIds(port);
      const { status, json } = await uploadFile(port, "empty.bin", Buffer.alloc(0));
      expect(status).toBe(400);
      expect(typeof json["error"]).toBe("string");
      expect(json["error"] as string).toMatch(/empty/i);
      expect(Object.keys(json)).toEqual(["error"]);

      // Backend boundary rejects directly too.
      const backend = createWebBackend({ manifestDir, registry: makeWebRegistry() });
      await expect(backend.uploadFile("empty.bin", Buffer.alloc(0))).rejects.toThrow(/empty/i);

      // No catalog entry was created.
      expect(await catalogFileIds(port)).toEqual(before);
    } finally {
      await web.close();
    }
  });

  it("7. oversized uploads are rejected before touching storage", async () => {
    const backend = createWebBackend({ manifestDir, registry: makeWebRegistry() });
    const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41);
    await expect(backend.uploadFile("huge.bin", tooBig)).rejects.toThrow(/too large/i);
  });

  it("8. filename and path traversal inputs are sanitized", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.alloc(64, 0x46);
      for (const hostile of ["../../etc/passwd", "..\\..\\win.ini", "/abs/path.txt", "a/b/c.txt"]) {
        const { status, json } = await uploadFile(port, hostile, fileData);
        expect(status).toBe(200);
        const stored = json["filename"] as string;
        expect(stored).not.toContain("/");
        expect(stored).not.toContain("\\");
        expect(stored).not.toContain("..");
        expect(stored.length).toBeGreaterThan(0);
        expect(stored.length).toBeLessThanOrEqual(255);
      }
      // "a+b.txt" must survive verbatim (no URL-decoding corruption).
      const plus = await uploadFile(port, "a+b.txt", fileData);
      expect(plus.status).toBe(200);
      expect(plus.json["filename"]).toBe("a+b.txt");

      // Backend rejects names that sanitize to nothing.
      const backend = createWebBackend({ manifestDir, registry: makeWebRegistry() });
      await expect(backend.uploadFile("../../", Buffer.alloc(8, 1))).rejects.toThrow(/filename/i);
    } finally {
      await web.close();
    }
  });

  it("9. plaintext never reaches node storage", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const marker = `plaintext-marker-${randomBytes(8).toString("hex")}`;
      const fileData = Buffer.from(`prefix-${marker}-suffix`);
      const { status, json } = await uploadFile(port, "secret.txt", fileData);
      expect(status).toBe(200);
      const fileId = json["fileId"] as string;

      // Resolve manifest piece IDs, then fetch each piece from the nodes.
      const store = createManifestStore({ dir: manifestDir });
      const manifest = await store.load(fileId);
      expect(manifest).toBeDefined();
      for (const pieceId of manifest!.pieceIds) {
        for (const node of nodes) {
          const getRes = await fetch(`${node.baseUrl}/pieces/${pieceId}`);
          expect(getRes.status).toBe(200);
          const pieceText = Buffer.from(await getRes.arrayBuffer()).toString("utf8");
          expect(pieceText).not.toContain(marker);
        }
      }
      // Raw bytes on disk likewise carry no plaintext.
      for (const pieceBytes of await readAllStoredPieces()) {
        expect(pieceBytes.includes(Buffer.from(marker, "utf8"))).toBe(false);
      }
    } finally {
      await web.close();
    }
  });

  it("10. encrypted pieces decrypt correctly through the download pipeline", async () => {
    // The web boundary intentionally discards the DEK, so the round-trip
    // is proven at the pipeline level the route delegates to.
    const fileData = randomBytes(5000);
    const store = createManifestStore({ dir: manifestDir });
    const { manifest, encryptionKey } = await uploadBuffer(fileData, "roundtrip.bin", liveEndpoints(), {
      manifestStore: store,
    });
    try {
      expect(manifest.totalChunks).toBeGreaterThanOrEqual(1);
      const roundTripped = await downloadBuffer(manifest, encryptionKey, liveEndpoints());
      expect(roundTripped.equals(fileData)).toBe(true);
      // A wrong key fails closed instead of returning garbage.
      const wrongKey = randomBytes(32);
      await expect(downloadBuffer(manifest, wrongKey, liveEndpoints())).rejects.toThrow();
    } finally {
      encryptionKey.fill(0);
    }
  });

  it("11. every piece is replicated on all live nodes", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.alloc(300, 0xBB);
      const { status, json } = await uploadFile(port, "repl-test.bin", fileData);
      expect(status).toBe(200);
      const store = createManifestStore({ dir: manifestDir });
      const manifest = await store.load(json["fileId"] as string);
      expect(manifest).toBeDefined();
      expect(manifest!.nodeIds).toHaveLength(3);
      for (const pieceId of manifest!.pieceIds) {
        for (const node of nodes) {
          const res = await fetch(`${node.baseUrl}/pieces/${pieceId}`);
          expect(res.status).toBe(200);
        }
      }
      const filesRes = await fetch(`http://127.0.0.1:${port}/api/files`);
      const filesJson = (await filesRes.json()) as { files: Array<Record<string, unknown>> };
      const found = filesJson.files.find((f) => f["fileId"] === json["fileId"]);
      expect(found).toBeDefined();
      expect(found!["filename"]).toBe("repl-test.bin");
      expect(found!["size"]).toBe(300);
    } finally {
      await web.close();
    }
  });

  it("12. manifest is persisted and served through the catalog", async () => {
    const freshManifestDir = await mkdtemp(join(tmpdir(), "openstore-upload-persist-"));
    const freshNodes: TestNode[] = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        const dir = await mkdtemp(join(tmpdir(), "openstore-upload-p3-node-"));
        const node = createStorageNode({ storageDir: dir });
        const port = await node.listen(0, "127.0.0.1");
        const ident = createIdentity();
        const nodeId = ident.publicKey.toString("base64");
        freshNodes.push({ id: nodeId, baseUrl: `http://127.0.0.1:${port}`, node, dir });
      }
      const reg = createRegistry();
      for (const n of freshNodes) {
        const ident = createIdentity();
        reg.register(n.baseUrl, ident, { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
      }
      const web = createWebServer({ manifestDir: freshManifestDir, registry: reg });
      const port = await web.listen(0, "127.0.0.1");
      try {
        const fileData = Buffer.alloc(256, 0xAA);
        const { status, json: uploadJson } = await uploadFile(port, "persisted-file.bin", fileData);
        expect(status).toBe(200);
        const filesRes = await fetch(`http://127.0.0.1:${port}/api/files`);
        const filesJson = (await filesRes.json()) as { files: Array<Record<string, unknown>>; source: string };
        expect(filesJson.source).toBe("live");
        const found = filesJson.files.find((f) => f["fileId"] === uploadJson["fileId"]);
        expect(found).toBeDefined();
        expect(found!["filename"]).toBe("persisted-file.bin");
        expect(found!["size"]).toBe(256);
      } finally {
        await web.close();
      }
    } finally {
      for (const n of freshNodes) {
        await n.node.close();
        await rm(n.dir, { recursive: true, force: true });
      }
      await rm(freshManifestDir, { recursive: true, force: true });
      await rm(`${freshManifestDir}.deks.json`, { force: true });
    }
  });

  it("13. partial node failure still succeeds without the dead node", async () => {
    const deadRegistry = createRegistry();
    const deadIdent = createIdentity();
    deadRegistry.register("http://127.0.0.1:1", deadIdent, { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
    const liveIdent = createIdentity();
    deadRegistry.register(nodes[0]!.baseUrl, liveIdent, { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
    const web = createWebServer({ manifestDir, registry: deadRegistry });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.alloc(128, 0xDD);
      const { status, json } = await uploadFile(port, "partial.bin", fileData);
      expect(status).toBe(200);
      expect(typeof json["fileId"]).toBe("string");
      const store = createManifestStore({ dir: manifestDir });
      const manifest = await store.load(json["fileId"] as string);
      expect(manifest).toBeDefined();
      // The unreachable node is absent; the live node carried the piece.
      expect(manifest!.nodeIds).not.toContain(deadIdent.publicKey.toString("base64"));
      expect(manifest!.nodeIds).toContain(liveIdent.publicKey.toString("base64"));
    } finally {
      await web.close();
    }
  });

  it("14. total node failure is a safe error with no catalog entry", async () => {
    const deadRegistry = createRegistry();
    deadRegistry.register("http://127.0.0.1:1", createIdentity(), { allocatedBytes: 1_073_741_824, usedBytes: 0, availableBytes: 1_073_741_824 });
    const web = createWebServer({ manifestDir, registry: deadRegistry });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const before = await catalogFileIds(port);
      const fileData = Buffer.alloc(100, 0xCC);
      const { status, json } = await uploadFile(port, "fail.bin", fileData);
      expect(status).toBe(500);
      expect(typeof json["error"]).toBe("string");
      expect(Object.keys(json)).toEqual(["error"]);
      expect(json["error"]).not.toContain("key");
      expect(json["error"]).not.toContain("password");
      expect(await catalogFileIds(port)).toEqual(before);
    } finally {
      await web.close();
    }
  });

  it("15. capacity exhaustion fails safely with no catalog entry", async () => {
    const tinyDir = await mkdtemp(join(tmpdir(), "openstore-upload-tiny-"));
    const tinyNode = createStorageNode({ storageDir: tinyDir, capacityBytes: 300 });
    const tinyPort = await tinyNode.listen(0, "127.0.0.1");
    const tinyRegistry = createRegistry();
    tinyRegistry.register(`http://127.0.0.1:${tinyPort}`, createIdentity(), { allocatedBytes: 300, usedBytes: 0, availableBytes: 300 });
    const web = createWebServer({ manifestDir, registry: tinyRegistry });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const before = await catalogFileIds(port);
      // 1 KiB of plaintext becomes a larger encrypted piece: far over 300 B.
      const { status, json } = await uploadFile(port, "too-big.bin", randomBytes(1024));
      expect(status).toBe(500);
      expect(typeof json["error"]).toBe("string");
      expect(await catalogFileIds(port)).toEqual(before);
    } finally {
      await web.close();
      await tinyNode.close();
      await rm(tinyDir, { recursive: true, force: true });
    }
  });

  it("16. browser/API responses contain no plaintext/key/private material", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const secretData = Buffer.from("super-secret-password-12345");
      const { status, json } = await uploadFile(port, "secret-upload.bin", secretData);
      expect(status).toBe(200);
      const uploadText = JSON.stringify(json);
      expect(uploadText).not.toContain("super-secret-password");
      expect(uploadText.toLowerCase()).not.toContain("privatekey");
      expect(uploadText.toLowerCase()).not.toContain("recoveryphrase");
      expect(uploadText.toLowerCase()).not.toContain("encryptionkey");
      expect(uploadText.toLowerCase()).not.toContain("password");
      const filesRes = await fetch(`http://127.0.0.1:${port}/api/files`);
      const filesText = await filesRes.text();
      expect(filesText).not.toContain("super-secret-password");
      expect(filesText.toLowerCase()).not.toContain("privatekey");
      expect(filesText.toLowerCase()).not.toContain("encryptionkey");

      // A failed upload's error is equally clean and minimal.
      const deadRegistry = createRegistry();
      deadRegistry.register("http://127.0.0.1:1", createIdentity(), { allocatedBytes: 1, usedBytes: 0, availableBytes: 1 });
      const failingWeb = createWebServer({ manifestDir, registry: deadRegistry });
      const failingPort = await failingWeb.listen(0, "127.0.0.1");
      try {
        const failed = await uploadFile(failingPort, "nope.bin", Buffer.alloc(32, 0x99));
        expect(failed.status).toBe(500);
        const failedText = JSON.stringify(failed.json);
        expect(failedText.toLowerCase()).not.toContain("privatekey");
        expect(failedText.toLowerCase()).not.toContain("encryptionkey");
        expect(failedText.toLowerCase()).not.toContain("password");
        expect(failedText.toLowerCase()).not.toContain("recoveryphrase");
      } finally {
        await failingWeb.close();
      }

      // The persisted manifest on disk carries metadata only.
      const store = createManifestStore({ dir: manifestDir });
      const manifest = await store.load(json["fileId"] as string);
      const manifestText = JSON.stringify(manifest);
      expect(manifestText).not.toContain("super-secret-password");
      expect(manifestText.toLowerCase()).not.toContain("privatekey");
      expect(manifestText.toLowerCase()).not.toContain("encryptionkey");
      expect(manifestText.toLowerCase()).not.toContain("password");
    } finally {
      await web.close();
    }
  });

  it("17. frontend never talks to storage nodes or persists secrets", async () => {
    // Static guard: the browser bundle must only ever POST uploads to the
    // same-origin web backend (which encrypts server-side). Direct piece
    // traffic or browser-side secret storage would break the threat model.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const name of ["app.ts", "store.ts", "views.ts", "types.ts", "mock.ts"]) {
      const text = await readFile(join(here, "src", name), "utf8");
      expect(text).not.toContain("/pieces");
      expect(text).not.toContain("localStorage");
      expect(text).not.toContain("sessionStorage");
    }
  });

  it("18. upload progress reaches correct terminal state", async () => {
    const { uploadComplete, uploadFailed, createInitialState } = await import("./src/store.js");
    let state = createInitialState();
    state = { ...state, upload: { status: "storing", fileName: "test.bin", fileSize: 100, note: null } };
    state = uploadComplete(state, { fileId: "abc", filename: "test.bin", size: 100, totalChunks: 1 });
    expect(state.upload.status).toBe("complete");
    expect(state.upload.note).toContain("test.bin");
    expect(state.upload.note).toContain("1 chunk");
    state = createInitialState();
    state = { ...state, upload: { status: "storing", fileName: "fail.bin", fileSize: 50, note: null } };
    state = uploadFailed(state, "insufficient nodes");
    expect(state.upload.status).toBe("failed");
    expect(state.upload.note).toMatch(/insufficient nodes/);
  });

  it("19. demo mode remains functional", async () => {
    const web = createWebServer({});
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.alloc(100, 0xEE);
      const { status, json } = await uploadFile(port, "demo-test.bin", fileData);
      expect(status).toBe(500);
      expect(typeof json["error"]).toBe("string");
      const filesRes = await fetch(`http://127.0.0.1:${port}/api/files`);
      expect(filesRes.status).toBe(200);
      const filesJson = (await filesRes.json()) as { source: string };
      expect(filesJson.source).toBe("demo");
    } finally {
      await web.close();
    }
  });
});
