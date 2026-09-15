/**
 * OpenStore Local Manifest Store (OPENSTORE-019)
 *
 * Persists encrypted file manifests locally so uploaded files can be
 * recovered after a client restart (manifest + explicitly supplied
 * encryption key → download flow).
 *
 * Safety guarantees:
 * - Only validated manifest metadata is persisted. Inputs are rebuilt
 *   through {@link buildManifest}, which rejects key material and drops
 *   unknown fields — so encryption keys, recovery phrases, private
 *   keys, plaintext, and decrypted data can never reach disk via save().
 * - Manifests are validated again on load; malformed/corrupted files
 *   fail with a clear error instead of returning garbage.
 * - Writes are atomic (tmp file + rename in the same directory) with
 *   restrictive 0o600 permissions.
 * - File IDs are restricted to a safe charset so manifest files can
 *   never escape the store directory (no path traversal).
 *
 * No database, stdlib only.
 */

import { randomBytes } from "crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { buildManifest } from "./index.js";
import type { FileManifest } from "./index.js";

export const MANIFEST_STORE_VERSION = 1;

const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MANIFEST_FILE_SUFFIX = ".json";

/**
 * Options for {@link createManifestStore}.
 */
export interface ManifestStoreOptions {
  /** Directory holding one `<fileId>.json` file per manifest. Created on demand. */
  dir: string;
}

/**
 * Minimal metadata for {@link ManifestStore.list}.
 */
export interface ManifestSummary {
  fileId: string;
  filename: string;
  size: number;
  totalChunks: number;
  /** Epoch millis when the manifest file was created (falls back to mtime). */
  createdAt: number;
}

/**
 * Local persistent store for file manifests.
 */
export interface ManifestStore {
  readonly dir: string;
  /** Validate and atomically persist a manifest. Returns a copy of what was stored. */
  save(manifest: FileManifest): Promise<FileManifest>;
  /** Load and validate a manifest, or undefined when absent. Throws on malformed files. */
  load(fileId: string): Promise<FileManifest | undefined>;
  /** Delete a manifest. Returns true when a file was removed. */
  delete(fileId: string): Promise<boolean>;
  /** List summaries of all valid manifests; malformed files are skipped safely. */
  list(): Promise<ManifestSummary[]>;
}

/**
 * Check whether a file ID is safe to map to a file name.
 */
export function isValidManifestFileId(fileId: string): boolean {
  return typeof fileId === "string" && fileId !== "" && FILE_ID_PATTERN.test(fileId);
}

function assertValidFileId(fileId: string): void {
  if (!isValidManifestFileId(fileId)) {
    throw new TypeError("fileId must be 1–128 chars of [A-Za-z0-9_-]");
  }
}

/**
 * Rebuild a manifest through validation, rejecting any key material.
 * buildManifest already rejects `key`/`encryptionKey` and drops unknown
 * fields; we additionally reject private-key/recovery-phrase carriers.
 */
function validatedManifest(manifest: FileManifest): FileManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("manifest must be an object");
  }
  const record = manifest as unknown as Record<string, unknown>;
  for (const forbidden of ["key", "encryptionKey", "privateKey", "recoveryPhrase", "plaintext", "decryptedData"]) {
    if (forbidden in record) {
      throw new Error("manifest store never persists key material or file contents");
    }
  }
  return buildManifest({
    fileId: manifest.fileId,
    filename: manifest.filename,
    size: manifest.size,
    chunkSize: manifest.chunkSize,
    cryptoVersion: manifest.cryptoVersion,
    chunks: manifest.chunks,
  });
}

/**
 * Create a manifest store bound to a local directory (created on demand).
 */
export function createManifestStore(options: ManifestStoreOptions): ManifestStore {
  if (!options || typeof options.dir !== "string" || options.dir === "") {
    throw new TypeError("dir must be a non-empty string");
  }
  const dir = resolve(options.dir);

  function pathFor(fileId: string): string {
    assertValidFileId(fileId);
    return join(dir, `${fileId}${MANIFEST_FILE_SUFFIX}`);
  }

  async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
    const payload = JSON.stringify({ version: MANIFEST_STORE_VERSION, manifest: value }, null, 2);
    await mkdir(dir, { recursive: true });
    const tmpPath = join(dir, `.tmp.${randomBytes(8).toString("hex")}${MANIFEST_FILE_SUFFIX}`);
    try {
      await writeFile(tmpPath, payload, { mode: 0o600 });
      try {
        await chmod(tmpPath, 0o600);
      } catch {}
      await rename(tmpPath, targetPath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {}
      throw err;
    }
  }

  function parseStored(text: string): FileManifest {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("malformed manifest file: invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("malformed manifest file: expected an object");
    }
    const record = parsed as Record<string, unknown>;
    if (!("manifest" in record)) {
      throw new Error("malformed manifest file: missing manifest");
    }
    try {
      return validatedManifest(record["manifest"] as FileManifest);
    } catch (err) {
      throw new Error(`malformed manifest file: ${(err as Error).message}`);
    }
  }

  return {
    dir,

    async save(manifest: FileManifest): Promise<FileManifest> {
      const checked = validatedManifest(manifest);
      await atomicWriteJson(pathFor(checked.fileId), checked);
      return checked;
    },

    async load(fileId: string): Promise<FileManifest | undefined> {
      const targetPath = pathFor(fileId);
      let text: string;
      try {
        text = await readFile(targetPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
      return parseStored(text);
    },

    async delete(fileId: string): Promise<boolean> {
      const targetPath = pathFor(fileId);
      try {
        await unlink(targetPath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },

    async list(): Promise<ManifestSummary[]> {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const summaries: ManifestSummary[] = [];
      for (const entry of entries.sort()) {
        if (!entry.endsWith(MANIFEST_FILE_SUFFIX) || entry.startsWith(".tmp.")) continue;
        const fileId = entry.slice(0, -MANIFEST_FILE_SUFFIX.length);
        if (!isValidManifestFileId(fileId)) continue;
        try {
          const text = await readFile(join(dir, entry), "utf8");
          const manifest = parseStored(text);
          let createdAt = 0;
          try {
            const s = await stat(join(dir, entry));
            createdAt = Math.floor(s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs);
          } catch {}
          summaries.push({
            fileId: manifest.fileId,
            filename: manifest.filename,
            size: manifest.size,
            totalChunks: manifest.totalChunks,
            createdAt,
          });
        } catch {
          // Skip malformed files safely; load() surfaces them explicitly.
        }
      }
      return summaries;
    },
  };
}
