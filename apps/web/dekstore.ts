/**
 * OpenStore Web DEK Vault (OPENSTORE-028)
 *
 * Server-side store for per-file data-encryption keys (DEKs) of files
 * uploaded through the web UI, so those files can later be downloaded
 * (decrypted server-side by the trusted client backend and streamed to
 * the owning browser).
 *
 * Security model — the minimum mechanism necessary:
 * - The web backend process is already trusted with file plaintext: the
 *   browser POSTs uploads to it and it encrypts before touching storage
 *   nodes. This vault extends that same trust to resting DEKs; it does
 *   NOT extend trust to storage nodes, manifests, or the browser.
 * - Plaintext DEKs never enter manifests (which are listable metadata),
 *   API responses, URLs, logs, or browser storage. The only reader is
 *   `downloadFile` in backend.ts, which wipes its copy after use.
 * - Single JSON file, restrictive 0o600 permissions, atomic writes
 *   (tmp file + rename in the same directory), validated on every read.
 * - One entry per fileId: `{ version: 1, deks: { "<fileId>": "<base64>" } }`.
 *   File IDs are restricted to the manifest store charset so keys can
 *   never escape into paths; DEKs must be exactly 32 bytes (AES-256).
 */

import { randomBytes } from "crypto";
import { chmod, mkdir, rename, readFile, unlink, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { KEY_BYTES } from "../../packages/crypto/index.js";
import { isValidManifestFileId } from "../../packages/manifest/store.js";

export const DEK_STORE_VERSION = 1;

export interface DekStoreOptions {
  /** File path of the vault JSON. Parent directory is created on demand. */
  path: string;
}

export interface DekStore {
  readonly path: string;
  /** Persist (or replace) the DEK for a file. */
  saveDek(fileId: string, dek: Uint8Array): Promise<void>;
  /** Load a file's DEK, or undefined when absent. Throws on corrupt entries. */
  loadDek(fileId: string): Promise<Buffer | undefined>;
  /** Delete a file's DEK. Returns true when an entry was removed. */
  deleteDek(fileId: string): Promise<boolean>;
}

function assertValidFileId(fileId: string): void {
  if (!isValidManifestFileId(fileId)) {
    throw new Error("fileId must be 1–128 chars of [A-Za-z0-9_-]");
  }
}

function assertValidDek(dek: Uint8Array): void {
  if (!(dek instanceof Uint8Array) || dek.length !== KEY_BYTES) {
    throw new Error(`dek must be exactly ${KEY_BYTES} bytes`);
  }
}

function parseVault(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("dek store is malformed: invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("dek store is malformed: expected an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== DEK_STORE_VERSION) {
    throw new Error(`dek store is malformed: unsupported version ${String(record["version"])}`);
  }
  const deks = record["deks"];
  if (!deks || typeof deks !== "object" || Array.isArray(deks)) {
    throw new Error("dek store is malformed: missing deks map");
  }
  const out: Record<string, string> = {};
  for (const [fileId, value] of Object.entries(deks as Record<string, unknown>)) {
    if (!isValidManifestFileId(fileId)) {
      throw new Error("dek store is malformed: invalid file id entry");
    }
    if (typeof value !== "string") {
      throw new Error("dek store is malformed: dek entry must be base64");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(value, "base64");
    } catch {
      throw new Error("dek store is malformed: dek entry must be base64");
    }
    if (bytes.length !== KEY_BYTES) {
      throw new Error("dek store is malformed: dek entry has wrong length");
    }
    out[fileId] = value;
  }
  return out;
}

/**
 * Create a DEK vault bound to a file path (created on demand).
 */
export function createDekStore(options: DekStoreOptions): DekStore {
  if (!options || typeof options.path !== "string" || options.path === "") {
    throw new TypeError("path must be a non-empty string");
  }
  const path = resolve(options.path);

  async function readAll(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    return parseVault(text);
  }

  async function writeAll(deks: Record<string, string>): Promise<void> {
    const payload = JSON.stringify({ version: DEK_STORE_VERSION, deks }, null, 2);
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = join(dirname(path), `.tmp.${randomBytes(8).toString("hex")}.json`);
    try {
      await writeFile(tmpPath, payload, { mode: 0o600 });
      try {
        await chmod(tmpPath, 0o600);
      } catch {}
      await rename(tmpPath, path);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {}
      throw err;
    }
  }

  return {
    path,

    async saveDek(fileId: string, dek: Uint8Array): Promise<void> {
      assertValidFileId(fileId);
      assertValidDek(dek);
      const all = await readAll();
      all[fileId] = Buffer.from(dek).toString("base64");
      await writeAll(all);
    },

    async loadDek(fileId: string): Promise<Buffer | undefined> {
      assertValidFileId(fileId);
      const all = await readAll();
      const value = all[fileId];
      if (value === undefined) return undefined;
      const bytes = Buffer.from(value, "base64");
      if (bytes.length !== KEY_BYTES) {
        throw new Error("dek store is malformed: dek entry has wrong length");
      }
      return bytes;
    },

    async deleteDek(fileId: string): Promise<boolean> {
      assertValidFileId(fileId);
      const all = await readAll();
      if (!(fileId in all)) return false;
      delete all[fileId];
      await writeAll(all);
      return true;
    },
  };
}
