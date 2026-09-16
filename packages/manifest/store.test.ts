import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { CRYPTO_VERSION } from "../crypto/index.js";
import { buildManifest, generateFileId } from "./index.js";
import type { FileManifest } from "./index.js";
import { createManifestStore, ManifestConflictError } from "./store.js";

function makeManifest(fileId: string, filename = "file.txt"): FileManifest {
  return buildManifest({
    fileId,
    filename,
    size: 5,
    chunkSize: 5,
    cryptoVersion: CRYPTO_VERSION,
    chunks: [
      {
        index: 0,
        pieceId: randomBytes(32).toString("hex"),
        plaintextHash: randomBytes(32).toString("hex"),
        plaintextSize: 5,
        encryptedSize: 100,
        nodeIds: ["node-a"],
      },
    ],
  });
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openstore-manifest-store-"));
}

describe("local manifest store (OPENSTORE-019)", () => {
  it("1. save → load preserves manifest", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const manifest = makeManifest(generateFileId(), "photo.png");
      const saved = await store.save(manifest);
      expect(saved).toEqual(manifest);
      expect((await store.loadWithRevision(manifest.fileId))?.revision).toBe(1);
      // A new store instance on the same dir (simulated restart) loads it back
      const reopened = createManifestStore({ dir });
      expect(await reopened.load(manifest.fileId)).toEqual(saved);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. delete removes manifest", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const manifest = makeManifest(generateFileId());
      await store.save(manifest);
      expect(await store.delete(manifest.fileId)).toBe(true);
      expect(await store.load(manifest.fileId)).toBeUndefined();
      expect(await store.delete(manifest.fileId)).toBe(false);
      expect(await store.list()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("3. multiple manifests remain independent", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const a = makeManifest(generateFileId(), "a.txt");
      const b = makeManifest(generateFileId(), "b.txt");
      const c = makeManifest(generateFileId(), "c.txt");
      await store.save(a);
      await store.save(b);
      await store.save(c);
      expect((await store.list()).map((s) => s.fileId).sort()).toEqual(
        [a.fileId, b.fileId, c.fileId].sort(),
      );
      expect(await store.delete(b.fileId)).toBe(true);
      expect(await store.load(a.fileId)).toMatchObject(a);
      expect(await store.load(c.fileId)).toMatchObject(c);
      expect(await store.load(b.fileId)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("4. malformed/corrupted manifest fails safely", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const fileId = generateFileId();
      // Corrupted: not JSON at all
      await writeFile(join(dir, `${fileId}.json`), "not json {{{", { mode: 0o600 });
      await expect(store.load(fileId)).rejects.toThrow(/malformed/i);
      // Malformed: valid JSON but missing manifest
      await writeFile(join(dir, `${fileId}.json`), JSON.stringify({ version: 1 }), { mode: 0o600 });
      await expect(store.load(fileId)).rejects.toThrow(/malformed/i);
      // Malformed: manifest with invalid chunk hash
      const bad = { ...makeManifest(generateFileId()), fileId, chunks: [] as unknown as FileManifest["chunks"] };
      (bad as unknown as Record<string, unknown>)["chunks"] = [
        { index: 0, pieceId: "not-a-hash", plaintextHash: "x", plaintextSize: 1, encryptedSize: 1, nodeIds: ["n"] },
      ];
      await writeFile(join(dir, `${fileId}.json`), JSON.stringify({ version: 1, manifest: bad }), { mode: 0o600 });
      await expect(store.load(fileId)).rejects.toThrow(/malformed/i);
      // list() skips malformed files instead of crashing
      expect(await store.list()).toHaveLength(0);
      // Unsafe file IDs are rejected (no traversal)
      await expect(store.load("../evil")).rejects.toThrow();
      await expect(store.load("../../etc/passwd")).rejects.toThrow();
      await expect(store.load("")).rejects.toThrow();
      await expect(store.delete("../evil")).rejects.toThrow();
      // Missing manifest loads as undefined (not an error)
      expect(await store.load(generateFileId())).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("5. persisted data contains no encryption key/private key/recovery phrase", async () => {
    const nodeDir = await mkdtemp(join(tmpdir(), "openstore-manifest-nodes-"));
    const storeDir = await tempDir();
    const { createStorageNode } = await import("../../apps/storage-node/index.js");
    const { uploadBuffer } = await import("../../apps/client/upload.js");
    const { generateEncryptionKey } = await import("../crypto/index.js");
    const node = createStorageNode({ storageDir: nodeDir });
    try {
      const port = await node.listen(0, "127.0.0.1");
      const endpoints = [{ id: "mstore-node", baseUrl: `http://127.0.0.1:${port}` }];
      const store = createManifestStore({ dir: storeDir });
      const secret = Buffer.from("manifest-store-secret-plaintext");
      const { manifest, encryptionKey } = await uploadBuffer(secret, "secret.txt", endpoints, { manifestStore: store });
      const content = await readFile(join(storeDir, `${manifest.fileId}.json`), "utf8");
      expect(content).not.toContain(Buffer.from(encryptionKey).toString("base64"));
      expect(content).not.toContain(Buffer.from(encryptionKey).toString("hex"));
      expect(content).not.toContain("manifest-store-secret-plaintext");
      expect(content).not.toContain(secret.toString("base64"));
      expect(content.toLowerCase()).not.toContain("encryptionkey");
      expect(content.toLowerCase()).not.toContain("privatekey");
      expect(content.toLowerCase()).not.toContain("recoveryphrase");
      // Only whitelisted manifest fields at top level
      const parsed = JSON.parse(content) as { manifest: Record<string, unknown> };
      const allowed = new Set(["version", "revision", "fileId", "filename", "size", "chunkSize", "totalChunks", "cryptoVersion", "chunks", "pieceIds", "nodeIds"]);
      for (const key of Object.keys(parsed.manifest)) {
        expect(allowed.has(key)).toBe(true);
      }
      // Restrictive permissions where supported
      try {
        const s = await stat(join(storeDir, `${manifest.fileId}.json`));
        if (process.platform !== "win32") {
          expect(s.mode & 0o077).toBe(0);
        }
      } catch {}
      void generateEncryptionKey;
    } finally {
      await node.close();
      await rm(nodeDir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("6. atomic write preserves previous valid manifest on failure", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const fileId = generateFileId();
      const valid = makeManifest(fileId, "keep-me.txt");
      await store.save(valid);
      const before = await readFile(join(dir, `${fileId}.json`), "utf8");

      // Invalid manifest with the same fileId fails before any write
      const invalid = {
        ...valid,
        chunks: [
          { index: 0, pieceId: "not-a-hash", plaintextHash: "x", plaintextSize: 1, encryptedSize: 1, nodeIds: ["n"] },
        ],
      } as unknown as FileManifest;
      await expect(store.save(invalid)).rejects.toThrow();
      // Previous valid manifest intact
      expect(await readFile(join(dir, `${fileId}.json`), "utf8")).toBe(before);
      expect(await store.load(fileId)).toMatchObject(valid);
      // No tmp leftovers
      const entries = await readdir(dir);
      expect(entries.filter((e) => e.startsWith(".tmp."))).toHaveLength(0);
      expect(entries).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("7. upload can persist its manifest", async () => {
    const nodeDir = await mkdtemp(join(tmpdir(), "openstore-manifest-up-"));
    const storeDir = await tempDir();
    const { createStorageNode } = await import("../../apps/storage-node/index.js");
    const { uploadBuffer } = await import("../../apps/client/upload.js");
    const node = createStorageNode({ storageDir: nodeDir });
    try {
      const port = await node.listen(0, "127.0.0.1");
      const endpoints = [{ id: "up-node", baseUrl: `http://127.0.0.1:${port}` }];
      const store = createManifestStore({ dir: storeDir });
      const { manifest, encryptionKey } = await uploadBuffer(Buffer.from("persist-via-upload"), "up.txt", endpoints, {
        manifestStore: store,
      });
      // Manifest retrievable after upload; key lives only with the caller
      expect(await store.load(manifest.fileId)).toEqual(manifest);
      expect((await store.load(manifest.fileId)) as unknown as Record<string, unknown>).not.toHaveProperty("encryptionKey");
      expect(encryptionKey).toBeDefined();
      // Upload without a store still works (backward compatible)
      const plain = await uploadBuffer(Buffer.from("no-store"), "plain.txt", endpoints);
      expect(plain.manifest.fileId).toBeDefined();
      expect(await store.load(plain.manifest.fileId)).toBeUndefined();
    } finally {
      await node.close();
      await rm(nodeDir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("8. loaded manifest works with existing download flow when key is supplied", async () => {
    const nodeDir = await mkdtemp(join(tmpdir(), "openstore-manifest-dl-"));
    const storeDir = await tempDir();
    const { createStorageNode } = await import("../../apps/storage-node/index.js");
    const { uploadBuffer } = await import("../../apps/client/upload.js");
    const { downloadBuffer } = await import("../../apps/client/download.js");
    const node = createStorageNode({ storageDir: nodeDir });
    try {
      const port = await node.listen(0, "127.0.0.1");
      const endpoints = [{ id: "dl-node", baseUrl: `http://127.0.0.1:${port}` }];
      const store = createManifestStore({ dir: storeDir });
      const original = Buffer.from("round-trip-after-restart-persist");
      const { manifest, encryptionKey } = await uploadBuffer(original, "round.txt", endpoints, { manifestStore: store });

      // Simulate client restart: fresh store handle, manifest reloaded, key supplied explicitly
      const restarted = createManifestStore({ dir: storeDir });
      const loaded = await restarted.load(manifest.fileId);
      expect(loaded).toEqual(manifest);
      const recovered = await downloadBuffer(loaded as FileManifest, encryptionKey, endpoints);
      expect(recovered.equals(original)).toBe(true);
    } finally {
      await node.close();
      await rm(nodeDir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("9. legacy manifests load with revision zero and receive a revision on save", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const manifest = makeManifest(generateFileId());
      await writeFile(
        join(dir, `${manifest.fileId}.json`),
        JSON.stringify({ version: 1, manifest }),
        { mode: 0o600 },
      );
      expect((await store.load(manifest.fileId))?.revision).toBeUndefined();
      expect(await store.loadWithRevision(manifest.fileId)).toMatchObject({ revision: 0 });
      const saved = await store.save(manifest);
      expect(saved).toEqual(manifest);
      expect((await store.loadWithRevision(manifest.fileId))?.revision).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("10. conditional updates increment and reject stale revisions", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const first = await store.save(makeManifest(generateFileId(), "first"));
      const updated = await store.saveIfRevision(first.fileId, 1, {
        ...first,
        filename: "second",
      });
      expect(updated).toEqual({ ...first, filename: "second" });
      expect((await store.loadWithRevision(first.fileId))?.revision).toBe(2);
      await expect(store.saveIfRevision(first.fileId, 1, first)).rejects.toBeInstanceOf(ManifestConflictError);
      expect((await store.loadWithRevision(first.fileId))?.revision).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("11. same-file updates serialize and different files remain independent", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const first = await store.save(makeManifest(generateFileId(), "base"));
      const sameFile = await Promise.allSettled([
        store.save({ ...first, filename: "one" }),
        store.save({ ...first, filename: "two" }),
      ]);
      expect(sameFile.filter((result) => result.status === "fulfilled")).toHaveLength(2);
      expect((await store.loadWithRevision(first.fileId))?.revision).toBe(3);

      const a = makeManifest(generateFileId(), "a");
      const b = makeManifest(generateFileId(), "b");
      const [savedA, savedB] = await Promise.all([store.save(a), store.save(b)]);
      expect((await store.loadWithRevision(savedA.fileId))?.revision).toBe(1);
      expect((await store.loadWithRevision(savedB.fileId))?.revision).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("12. failed validation leaves the prior revision and data intact", async () => {
    const dir = await tempDir();
    try {
      const store = createManifestStore({ dir });
      const saved = await store.save(makeManifest(generateFileId()));
      const invalid = {
        ...saved,
        chunks: [{ ...saved.chunks[0], pieceId: "invalid" }],
      } as FileManifest;
      await expect(store.saveIfRevision(saved.fileId, 1, invalid)).rejects.toThrow();
      expect(await store.load(saved.fileId)).toEqual(saved);
      expect((await store.loadWithRevision(saved.fileId))?.revision).toBe(1);
      // A failed operation must not poison the per-file queue.
      await store.save({ ...saved, filename: "after-failure" });
      expect((await store.loadWithRevision(saved.fileId))?.revision).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
