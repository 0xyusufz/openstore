import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createManifestStore } from "../../packages/manifest/store.js";
import { generateFileId } from "../../packages/manifest/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import type { StorageNodeEndpoint } from "./index.js";
import { uploadBuffer } from "./upload.js";
import { downloadBuffer } from "./download.js";
import { createFileCatalog } from "./catalog.js";

let nodeDir = "";
let storeDir = "";
let node: StorageNode;
let endpoints: StorageNodeEndpoint[] = [];

beforeAll(async () => {
  nodeDir = await mkdtemp(join(tmpdir(), "openstore-catalog-node-"));
  storeDir = await mkdtemp(join(tmpdir(), "openstore-catalog-store-"));
  node = createStorageNode({ storageDir: nodeDir });
  const port = await node.listen(0, "127.0.0.1");
  endpoints = [{ id: "catalog-node", baseUrl: `http://127.0.0.1:${port}` }];
});

afterAll(async () => {
  await node.close();
  await rm(nodeDir, { recursive: true, force: true });
  await rm(storeDir, { recursive: true, force: true });
});

describe("client file catalog (OPENSTORE-020)", () => {
  it("1. upload two files → catalog lists both", async () => {
    const store = createManifestStore({ dir: storeDir });
    const catalog = createFileCatalog(store);
    const first = await uploadBuffer(Buffer.from("catalog-file-one"), "one.txt", endpoints, { manifestStore: store });
    const second = await uploadBuffer(Buffer.from("catalog-file-two"), "two.txt", endpoints, { manifestStore: store });

    const entries = await catalog.listEntries();
    const ids = entries.map((e) => e.fileId).sort();
    expect(ids).toEqual([first.manifest.fileId, second.manifest.fileId].sort());
    const byId = new Map(entries.map((e) => [e.fileId, e]));
    expect(byId.get(first.manifest.fileId)?.filename).toBe("one.txt");
    expect(byId.get(second.manifest.fileId)?.filename).toBe("two.txt");
    expect(byId.get(first.manifest.fileId)?.size).toBe(Buffer.from("catalog-file-one").length);

    // Download still works for cataloged files when the key is supplied
    const recovered = await downloadBuffer(first.manifest, first.encryptionKey, endpoints);
    expect(recovered.equals(Buffer.from("catalog-file-one"))).toBe(true);
  });

  it("2. get file metadata by fileId", async () => {
    const store = createManifestStore({ dir: storeDir });
    const catalog = createFileCatalog(store);
    const { manifest } = await uploadBuffer(Buffer.from("catalog-get-me"), "get.txt", endpoints, { manifestStore: store });

    const entry = await catalog.getEntry(manifest.fileId);
    expect(entry).toBeDefined();
    expect(entry?.fileId).toBe(manifest.fileId);
    expect(entry?.filename).toBe("get.txt");
    expect(entry?.size).toBe(manifest.size);
    expect(entry?.totalChunks).toBe(manifest.totalChunks);
    expect(entry?.chunkSize).toBe(manifest.chunkSize);
    // Missing file resolves to undefined, not an error
    expect(await catalog.getEntry(generateFileId())).toBeUndefined();
    // Invalid IDs are rejected clearly
    await expect(catalog.getEntry("../evil")).rejects.toThrow();
  });

  it("3. remove file metadata", async () => {
    const store = createManifestStore({ dir: storeDir });
    const catalog = createFileCatalog(store);
    const { manifest } = await uploadBuffer(Buffer.from("catalog-remove-me"), "rm.txt", endpoints, { manifestStore: store });
    expect(await catalog.getEntry(manifest.fileId)).toBeDefined();

    expect(await catalog.removeEntry(manifest.fileId)).toBe(true);
    expect(await catalog.getEntry(manifest.fileId)).toBeUndefined();
    expect(await catalog.removeEntry(manifest.fileId)).toBe(false);
  });

  it("4. removed file no longer appears", async () => {
    const store = createManifestStore({ dir: storeDir });
    const catalog = createFileCatalog(store);
    const keep = await uploadBuffer(Buffer.from("catalog-keep"), "keep.txt", endpoints, { manifestStore: store });
    const drop = await uploadBuffer(Buffer.from("catalog-drop"), "drop.txt", endpoints, { manifestStore: store });
    expect((await catalog.listEntries()).map((e) => e.fileId)).toContain(drop.manifest.fileId);

    await catalog.removeEntry(drop.manifest.fileId);
    const ids = (await catalog.listEntries()).map((e) => e.fileId);
    expect(ids).not.toContain(drop.manifest.fileId);
    expect(ids).toContain(keep.manifest.fileId);
  });

  it("5. malformed manifest is not returned as a valid catalog entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-catalog-malformed-"));
    try {
      const store = createManifestStore({ dir });
      const catalog = createFileCatalog(store);
      const { manifest } = await uploadBuffer(Buffer.from("catalog-good"), "good.txt", endpoints, { manifestStore: store });
      // Plant a corrupted manifest file alongside the valid one
      const badId = generateFileId();
      await writeFile(join(dir, `${badId}.json`), "{corrupted-json", { mode: 0o600 });

      const entries = await catalog.listEntries();
      expect(entries.map((e) => e.fileId)).toEqual([manifest.fileId]);
      // Direct access to the corrupted manifest fails clearly
      await expect(catalog.getEntry(badId)).rejects.toThrow(/malformed/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("6. catalog contains no key/private/recovery material", async () => {
    const store = createManifestStore({ dir: storeDir });
    const catalog = createFileCatalog(store);
    const secret = Buffer.from("catalog-secret-plaintext");
    const { manifest, encryptionKey } = await uploadBuffer(secret, "secret.txt", endpoints, { manifestStore: store });

    const entries = await catalog.listEntries();
    const text = JSON.stringify(entries);
    expect(text).not.toContain(Buffer.from(encryptionKey).toString("base64"));
    expect(text).not.toContain(Buffer.from(encryptionKey).toString("hex"));
    expect(text).not.toContain("catalog-secret-plaintext");
    expect(text).not.toContain(secret.toString("base64"));
    expect(text.toLowerCase()).not.toContain("encryptionkey");
    expect(text.toLowerCase()).not.toContain("privatekey");
    expect(text.toLowerCase()).not.toContain("recoveryphrase");
    // Entries expose exactly the whitelisted metadata fields
    const allowed = new Set(["fileId", "filename", "size", "totalChunks", "chunkSize", "createdAt"]);
    for (const entry of entries) {
      for (const key of Object.keys(entry)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    const entry = await catalog.getEntry(manifest.fileId);
    expect(entry).toBeDefined();
    expect(typeof entry?.createdAt === "number" || entry?.createdAt === undefined).toBe(true);
    const listed = entries.find((e) => e.fileId === manifest.fileId);
    expect(typeof listed?.createdAt).toBe("number");
    expect(listed?.createdAt as number).toBeGreaterThan(0);
  });
});
