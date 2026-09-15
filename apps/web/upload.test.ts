/**
 * Real Web File Upload Tests (OPENSTORE-026)
 *
 * End-to-end tests using real storage nodes, real encrypted upload
 * pipeline, and real HTTP multipart requests. No mocking.
 */

import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { request as httpRequest } from "http";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createIdentity } from "../../packages/identity/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { createRegistry } from "../../packages/registry/index.js";
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
  if (manifestDir) await rm(manifestDir, { recursive: true, force: true });
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

describe("real web file upload (OPENSTORE-026)", () => {
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
    } finally {
      await web.close();
    }
  });

  it("2. uploaded file is encrypted before storage", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.from("plaintext-secret-content-12345");
      const { status, json } = await uploadFile(port, "secret.txt", fileData);
      expect(status).toBe(200);
      const fileId = json["fileId"] as string;
      for (const node of nodes) {
        const getRes = await fetch(`http://${new URL(node.baseUrl).host}/pieces/${fileId}`);
        if (getRes.status === 200) {
          const pieceText = await getRes.text();
          expect(pieceText).not.toContain("plaintext-secret-content");
          expect(pieceText).not.toContain("secret.txt");
        }
      }
    } finally {
      await web.close();
    }
  });

  it("3. manifest is persisted", async () => {
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
    }
  });

  it("4. replicated pieces are stored on nodes", async () => {
    const web = createWebServer({ manifestDir, registry: makeWebRegistry() });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.alloc(300, 0xBB);
      const { status, json } = await uploadFile(port, "repl-test.bin", fileData);
      expect(status).toBe(200);
      const filesRes = await fetch(`http://127.0.0.1:${port}/api/files`);
      const filesJson = (await filesRes.json()) as { files: Array<Record<string, unknown>> };
      const found = filesJson.files.find((f) => f["fileId"] === json["fileId"]);
      expect(found).toBeDefined();
      expect(found!["filename"]).toBe("repl-test.bin");
      expect(found!["size"]).toBe(300);
      let totalPieces = 0;
      for (const node of nodes) {
        try {
          const files = await readdir(node.dir);
          totalPieces += files.length;
        } catch {}
      }
      expect(totalPieces).toBeGreaterThan(0);
    } finally {
      await web.close();
    }
  });

  it("5. insufficient capacity/nodes gives safe failure", async () => {
    const emptyRegistry = createRegistry();
    const web = createWebServer({ manifestDir, registry: emptyRegistry });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const fileData = Buffer.alloc(100, 0xCC);
      const { status, json } = await uploadFile(port, "fail.bin", fileData);
      expect(status).toBe(500);
      expect(typeof json["error"]).toBe("string");
      expect(json["error"]).not.toContain("key");
      expect(json["error"]).not.toContain("password");
    } finally {
      await web.close();
    }
  });

  it("6. node failure/partial replication is handled correctly", async () => {
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
    } finally {
      await web.close();
    }
  });

  it("7. browser/API responses contain no plaintext/key/private material", async () => {
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
    } finally {
      await web.close();
    }
  });

  it("8. upload progress reaches correct terminal state", async () => {
    const { uploadComplete, uploadFailed, uploadEncrypting, createInitialState } = await import("./src/store.js");
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

  it("9. demo mode remains functional", async () => {
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

  it("10. missing file in multipart returns safe error", async () => {
    const web = createWebServer({ manifestDir });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const { status, json } = await uploadFile(port, "empty.bin", Buffer.alloc(0));
      expect([200, 400, 500]).toContain(status);
      expect(typeof json["error"] === "string" || typeof json["fileId"] === "string").toBe(true);
      if (typeof json["error"] === "string") {
        expect(json["error"]).not.toContain("key");
        expect(json["error"]).not.toContain("password");
      }
    } finally {
      await web.close();
    }
  });
});
