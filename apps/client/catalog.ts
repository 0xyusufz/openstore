/**
 * OpenStore Client File Catalog (OPENSTORE-020)
 *
 * A simple client-side catalog over the persisted {@link ManifestStore}.
 * Lists, describes, and removes stored file metadata — a view layer only:
 * no new persistence, no plaintext, no keys.
 *
 * Safety guarantees:
 * - Entries expose safe metadata only: fileId, filename, size,
 *   totalChunks, chunkSize, createdAt (when the store provides it).
 *   Encryption keys, private keys, recovery phrases, plaintext
 *   contents, and piece bytes are never part of a catalog entry.
 * - Loading an entry revalidates the underlying manifest, so corrupt
 *   data can never surface as a valid entry: missing manifests resolve
 *   to undefined, malformed ones throw a clear error.
 */

import type { ManifestStore } from "../../packages/manifest/store.js";

/**
 * Safe file metadata for one cataloged upload.
 */
export interface CatalogEntry {
  fileId: string;
  filename: string;
  size: number;
  totalChunks: number;
  chunkSize: number;
  /** Epoch millis when the manifest was stored, when available. */
  createdAt?: number;
}

/**
 * Client-side file catalog backed by a {@link ManifestStore}.
 */
export interface FileCatalog {
  /** The underlying manifest store (reuse, not a new persistence layer). */
  readonly store: ManifestStore;
  /** List all valid catalog entries; malformed manifests are excluded. */
  listEntries(): Promise<CatalogEntry[]>;
  /**
   * Get one entry by fileId.
   * @returns The entry, or undefined when no manifest is stored.
   * @throws On invalid file IDs or malformed stored manifests.
   */
  getEntry(fileId: string): Promise<CatalogEntry | undefined>;
  /** Remove one entry's metadata. Returns true when an entry was removed. */
  removeEntry(fileId: string): Promise<boolean>;
}

function toEntry(
  summary: { fileId: string; filename: string; size: number; totalChunks: number; createdAt?: number },
  chunkSize: number,
): CatalogEntry {
  return {
    fileId: summary.fileId,
    filename: summary.filename,
    size: summary.size,
    totalChunks: summary.totalChunks,
    chunkSize,
    ...(summary.createdAt !== undefined && summary.createdAt > 0 ? { createdAt: summary.createdAt } : {}),
  };
}

/**
 * Create a file catalog over an existing manifest store.
 */
export function createFileCatalog(manifestStore: ManifestStore): FileCatalog {
  if (
    !manifestStore ||
    typeof manifestStore !== "object" ||
    typeof manifestStore.load !== "function" ||
    typeof manifestStore.delete !== "function" ||
    typeof manifestStore.list !== "function"
  ) {
    throw new TypeError("manifestStore must expose load, delete, and list");
  }
  return {
    store: manifestStore,

    async listEntries(): Promise<CatalogEntry[]> {
      const summaries = await manifestStore.list();
      const entries: CatalogEntry[] = [];
      for (const summary of summaries) {
        // Revalidate through load() so only fully valid manifests surface.
        // list() already skips malformed files; a manifest that became
        // unreadable in between is skipped here as well.
        try {
          const manifest = await manifestStore.load(summary.fileId);
          if (!manifest) continue;
          entries.push(toEntry(summary, manifest.chunkSize));
        } catch {
          continue;
        }
      }
      return entries;
    },

    async getEntry(fileId: string): Promise<CatalogEntry | undefined> {
      // load() validates the file ID, returns undefined when missing,
      // and throws a clear error on malformed manifests.
      const manifest = await manifestStore.load(fileId);
      if (!manifest) return undefined;
      return {
        fileId: manifest.fileId,
        filename: manifest.filename,
        size: manifest.size,
        totalChunks: manifest.totalChunks,
        chunkSize: manifest.chunkSize,
      };
    },

    async removeEntry(fileId: string): Promise<boolean> {
      return manifestStore.delete(fileId);
    },
  };
}
