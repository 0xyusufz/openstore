/**
 * OpenStore Chunking Module
 *
 * Responsible for:
 * - Splitting file data into ordered fixed-size chunks
 * - Calculating SHA-256 for every chunk
 * - Reconstructing the original data from chunks
 * - Rejecting invalid/missing/duplicate/out-of-order chunks
 *
 * MVP strategy:
 * Fixed-size chunking with a 4 MiB default.
 *
 * Architectural guarantees:
 * - Deterministic: the same input always yields identical chunks/hashes.
 * - Pure data transformation: no network I/O here; chunk structs are
 *   versioned so manifest/protocol layers can evolve independently.
 */

import { createHash } from "crypto";

export const CHUNKING_VERSION = 1;

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

const SHA256_HEX_LENGTH = 64;

/**
 * Versioned representation of a single file chunk.
 * Indexes are zero-based; `total` is the chunk count of the file
 * so truncation (e.g. a missing tail chunk) is detectable.
 */
export interface FileChunk {
  version: number;
  index: number;
  total: number;
  data: Buffer;
  hash: string;
}

/**
 * Split file data into ordered chunks with SHA-256 hashes.
 *
 * @param data File bytes to split (may be empty → no chunks).
 * @param chunkSize Maximum bytes per chunk (defaults to 4 MiB).
 * @returns Ordered chunks with zero-based indexes.
 * @throws If `data` is not a Buffer or `chunkSize` is not a positive integer.
 */
export function chunkData(
  data: Buffer,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): FileChunk[] {
  if (!Buffer.isBuffer(data)) {
    throw new TypeError("data must be a Buffer");
  }
  assertValidChunkSize(chunkSize);

  if (data.length === 0) {
    return [];
  }

  const total = Math.ceil(data.length / chunkSize);
  const chunks: FileChunk[] = [];
  for (let index = 0; index < total; index += 1) {
    const slice = Buffer.from(
      data.subarray(index * chunkSize, (index + 1) * chunkSize),
    );
    chunks.push({
      version: CHUNKING_VERSION,
      index,
      total,
      data: slice,
      hash: hashBytes(slice),
    });
  }
  return chunks;
}

/**
 * Reconstruct the original file data from chunks.
 *
 * Chunks must be supplied complete and in ascending zero-based order;
 * any gap, duplicate, reorder, truncation, version mismatch, or hash
 * mismatch throws, so callers must treat throws as rejection.
 *
 * @param chunks Ordered chunks from {@link chunkData}.
 * @returns Original file bytes (`Buffer.alloc(0)` for no chunks).
 * @throws If chunks are invalid/missing/duplicate/out-of-order/tampered.
 */
export function reassembleChunks(chunks: FileChunk[]): Buffer {
  if (!Array.isArray(chunks)) {
    throw new TypeError("chunks must be an array");
  }
  if (chunks.length === 0) {
    return Buffer.alloc(0);
  }

  const total = chunks.length;
  for (let position = 0; position < total; position += 1) {
    const chunk = chunks[position] as FileChunk;
    if (!chunk || typeof chunk !== "object") {
      throw new Error(`chunk at position ${position} must be an object`);
    }
    if (chunk.version !== CHUNKING_VERSION) {
      throw new Error(`unsupported chunking version: ${chunk.version}`);
    }
    if (chunk.index !== position) {
      throw new Error(
        `chunks must be complete and in ascending order: expected index ${position}, got ${chunk.index}`,
      );
    }
    if (chunk.total !== total) {
      throw new Error(
        `chunk ${position} declares total ${chunk.total}, expected ${total}`,
      );
    }
    if (!Buffer.isBuffer(chunk.data) || chunk.data.length === 0) {
      throw new Error(`chunk ${position} data must be a non-empty Buffer`);
    }
    if (
      typeof chunk.hash !== "string" ||
      chunk.hash.length !== SHA256_HEX_LENGTH
    ) {
      throw new Error(`chunk ${position} has an invalid SHA-256 hash`);
    }
    if (hashBytes(chunk.data) !== chunk.hash) {
      throw new Error(`chunk ${position} hash mismatch: data was modified`);
    }
  }

  return Buffer.concat(chunks.map((chunk) => chunk.data));
}

function hashBytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertValidChunkSize(chunkSize: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }
}
