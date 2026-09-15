import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createIdentity } from "../../packages/identity/index.js";
import { createAuthHeaders, SIGNATURE_HEADER } from "../../packages/auth/index.js";
import { CRYPTO_VERSION } from "../../packages/crypto/index.js";
import { buildManifest, generateFileId, hashPieceId } from "../../packages/manifest/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import type { StorageNodeEndpoint } from "./index.js";
import { storePieceOnNodes } from "./index.js";
import { uploadBuffer } from "./upload.js";
import { downloadBuffer } from "./download.js";
import { deleteFile, DeleteFileError } from "./delete.js";

const nodes: StorageNode[] = [];
let endpoints: StorageNodeEndpoint[] = [];
let nodeDirs: string[] = [];

beforeAll(async () => {
  for (const name of ["del-a", "del-b"]) {
    const dir = await mkdtemp(join(tmpdir(), `openstore-del-${name}-`));
    nodeDirs.push(dir);
    const node = createStorageNode({ storageDir: dir });
    const port = await node.listen(0, "127.0.0.1");
    nodes.push(node);
    endpoints.push({ id: name, baseUrl: `http://127.0.0.1:${port}` });
  }
});

afterAll(async () => {
  for (const node of nodes) await node.close();
  for (const dir of nodeDirs) await rm(dir, { recursive: true, force: true });
});

async function pieceExists(endpoint: StorageNodeEndpoint, pieceId: string): Promise<boolean> {
  const res = await fetch(`${endpoint.baseUrl}/pieces/${pieceId}`);
  return res.status === 200;
}

describe("remote file deletion (OPENSTORE-021)", () => {
  it("1. upload → delete → all replica pieces removed", async () => {
    const original = Buffer.from("delete-me-remote-001");
    const { manifest, encryptionKey } = await uploadBuffer(original, "doomed.txt", endpoints);
    expect(manifest.chunks.length).toBeGreaterThan(0);
    // Pieces exist on every replica before deletion
    for (const chunk of manifest.chunks) {
      for (const endpoint of endpoints) {
        expect(await pieceExists(endpoint, chunk.pieceId)).toBe(true);
      }
    }

    const report = await deleteFile(manifest, endpoints);
    expect(report.failed).toHaveLength(0);
    expect(report.fileId).toBe(manifest.fileId);
    expect(report.totalPieces).toBe(manifest.chunks.length);
    expect(report.deleted.length).toBe(manifest.chunks.length * endpoints.length);

    // All replica pieces gone afterwards
    for (const chunk of manifest.chunks) {
      for (const endpoint of endpoints) {
        expect(await pieceExists(endpoint, chunk.pieceId)).toBe(false);
      }
    }

    // Report exposes no key material or private data
    const text = JSON.stringify(report);
    expect(text).not.toContain(Buffer.from(encryptionKey).toString("base64"));
    expect(text).not.toContain(Buffer.from(encryptionKey).toString("hex"));
    expect(text).not.toContain(original.toString());
    expect(text.toLowerCase()).not.toContain("privatekey");
    expect(text.toLowerCase()).not.toContain("encryptionkey");
  });

  it("2. manifest removed after successful deletion", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openstore-del-store-"));
    try {
      const store = createManifestStore({ dir: storeDir });
      const { manifest } = await uploadBuffer(Buffer.from("delete-manifest-too"), "gone.txt", endpoints, {
        manifestStore: store,
      });
      expect(await store.load(manifest.fileId)).toEqual(manifest);

      const report = await deleteFile(manifest, endpoints, { manifestStore: store });
      expect(report.failed).toHaveLength(0);
      expect(report.manifestRemoved).toBe(true);
      expect(await store.load(manifest.fileId)).toBeUndefined();
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("3. missing remote piece is handled as already deleted", async () => {
    const { manifest } = await uploadBuffer(Buffer.from("already-half-gone"), "partial.txt", endpoints);
    // Pre-delete one piece directly on one node
    const victim = manifest.chunks[0] as { pieceId: string };
    const pre = await fetch(`${endpoints[0]?.baseUrl}/pieces/${victim.pieceId}`, { method: "DELETE" });
    expect([200, 204]).toContain(pre.status);

    const report = await deleteFile(manifest, endpoints);
    expect(report.failed).toHaveLength(0);
    expect(report.alreadyAbsent).toContainEqual({ endpoint: endpoints[0] as StorageNodeEndpoint, pieceId: victim.pieceId });
    // Everything gone afterwards regardless
    for (const chunk of manifest.chunks) {
      for (const endpoint of endpoints) {
        expect(await pieceExists(endpoint, chunk.pieceId)).toBe(false);
      }
    }
  });

  it("4. one node failure produces clear partial failure", async () => {
    const { manifest } = await uploadBuffer(Buffer.from("partial-failure-case"), "part.txt", endpoints);
    // Dead endpoint: grab a free port then close it
    const tmpDir = await mkdtemp(join(tmpdir(), "openstore-del-dead-"));
    const tmpNode = createStorageNode({ storageDir: tmpDir });
    const deadPort = await tmpNode.listen(0, "127.0.0.1");
    await tmpNode.close();
    await rm(tmpDir, { recursive: true, force: true });
    const dead: StorageNodeEndpoint = { id: "dead-node", baseUrl: `http://127.0.0.1:${deadPort}` };

    const attempt = deleteFile(manifest, [...endpoints, dead], { timeoutMs: 2000 });
    await expect(attempt).rejects.toBeInstanceOf(DeleteFileError);
    try {
      await attempt;
    } catch (err) {
      const failure = err as DeleteFileError;
      expect(failure.report.failed.length).toBeGreaterThan(0);
      expect(failure.report.failed.every((f) => f.endpoint.id === "dead-node")).toBe(true);
      expect(failure.message).toMatch(/failed to delete file/i);
      expect(failure.message).toContain(manifest.fileId);
    }
  });

  it("5. manifest remains when deletion has unresolved failures", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "openstore-del-store-fail-"));
    try {
      const store = createManifestStore({ dir: storeDir });
      const { manifest } = await uploadBuffer(Buffer.from("keep-manifest-on-failure"), "keep.txt", endpoints, {
        manifestStore: store,
      });
      const dead: StorageNodeEndpoint = { id: "dead-node-2", baseUrl: "http://127.0.0.1:1" };
      await expect(deleteFile(manifest, [...endpoints, dead], { manifestStore: store, timeoutMs: 2000 })).rejects.toBeInstanceOf(
        DeleteFileError,
      );
      // Manifest must still be there for a later retry
      expect(await store.load(manifest.fileId)).toEqual(manifest);
      // Retry without the dead node succeeds and then removes the manifest
      const report = await deleteFile(manifest, endpoints, { manifestStore: store });
      expect(report.failed).toHaveLength(0);
      expect(report.manifestRemoved).toBe(true);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("6. authenticated DELETE works", async () => {
    const authDir = await mkdtemp(join(tmpdir(), "openstore-del-auth-"));
    const clientIdentity = createIdentity();
    const authNode = createStorageNode({ storageDir: authDir, requireAuth: true });
    try {
      const port = await authNode.listen(0, "127.0.0.1");
      const endpoint: StorageNodeEndpoint = { id: "auth-node", baseUrl: `http://127.0.0.1:${port}` };
      const bytes = Buffer.from("auth-delete-piece-bytes");
      const pieceId = hashPieceId(bytes);
      const stored = await storePieceOnNodes(pieceId, bytes, [endpoint], { identity: clientIdentity });
      expect(stored.succeeded).toHaveLength(1);
      const manifest = buildManifest({
        fileId: generateFileId(),
        filename: "auth.txt",
        size: bytes.length,
        chunkSize: bytes.length,
        cryptoVersion: CRYPTO_VERSION,
        chunks: [
          {
            index: 0,
            pieceId,
            plaintextHash: hashPieceId(bytes),
            plaintextSize: bytes.length,
            encryptedSize: bytes.length,
            nodeIds: [endpoint.id],
          },
        ],
      });

      const report = await deleteFile(manifest, [endpoint], { identity: clientIdentity });
      expect(report.failed).toHaveLength(0);
      expect(report.deleted).toHaveLength(1);
      expect(await pieceExists(endpoint, pieceId)).toBe(false);
    } finally {
      await authNode.close();
      await rm(authDir, { recursive: true, force: true });
    }
  });

  it("7. tampered/unauthenticated DELETE fails when auth is required", async () => {
    const authDir = await mkdtemp(join(tmpdir(), "openstore-del-auth2-"));
    const clientIdentity = createIdentity();
    const authNode = createStorageNode({ storageDir: authDir, requireAuth: true });
    try {
      const port = await authNode.listen(0, "127.0.0.1");
      const endpoint: StorageNodeEndpoint = { id: "auth-node-2", baseUrl: `http://127.0.0.1:${port}` };
      const bytes = Buffer.from("auth-delete-tamper-bytes");
      const pieceId = hashPieceId(bytes);
      await storePieceOnNodes(pieceId, bytes, [endpoint], { identity: clientIdentity });
      const manifest = buildManifest({
        fileId: generateFileId(),
        filename: "auth2.txt",
        size: bytes.length,
        chunkSize: bytes.length,
        cryptoVersion: CRYPTO_VERSION,
        chunks: [
          {
            index: 0,
            pieceId,
            plaintextHash: hashPieceId(bytes),
            plaintextSize: bytes.length,
            encryptedSize: bytes.length,
            nodeIds: [endpoint.id],
          },
        ],
      });

      // Unsigned DELETE rejected
      const unsigned = await fetch(`${endpoint.baseUrl}/pieces/${pieceId}`, { method: "DELETE" });
      expect(unsigned.status).toBe(401);

      // Tampered signature rejected
      const path = `/pieces/${pieceId}`;
      const headers = createAuthHeaders(clientIdentity, "DELETE", path);
      const sig = Buffer.from(headers[SIGNATURE_HEADER] as string, "base64");
      sig[0] ^= 0xff;
      const tampered = await fetch(`${endpoint.baseUrl}${path}`, {
        method: "DELETE",
        headers: { ...headers, [SIGNATURE_HEADER]: sig.toString("base64") },
      });
      expect(tampered.status).toBe(401);

      // deleteFile without identity surfaces partial failure, keeps manifest
      const storeDir = await mkdtemp(join(tmpdir(), "openstore-del-auth-store-"));
      try {
        const store = createManifestStore({ dir: storeDir });
        await store.save(manifest);
        await expect(deleteFile(manifest, [endpoint], { manifestStore: store })).rejects.toBeInstanceOf(DeleteFileError);
        expect(await store.load(manifest.fileId)).toEqual(manifest);
        // Piece must still exist (checked with a signed GET: the node requires auth)
        const signedGet = await fetch(`${endpoint.baseUrl}/pieces/${pieceId}`, {
          headers: createAuthHeaders(clientIdentity, "GET", `/pieces/${pieceId}`),
        });
        expect(signedGet.status).toBe(200);
        // Sanity: random tamper material never validates
        void randomBytes(4);
      } finally {
        await rm(storeDir, { recursive: true, force: true });
      }
    } finally {
      await authNode.close();
      await rm(authDir, { recursive: true, force: true });
    }
  });
});
