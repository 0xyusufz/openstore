/**
 * OpenStore Upload Pipeline (OPENSTORE-005)
 *
 * Responsible for:
 * - Uploading a complete Buffer through chunking, client-side
 *   encryption, and replicated multi-node storage in one flow
 * - Returning the versioned file manifest plus the encryption key
 *
 * MVP flow per file:
 * Buffer → chunks → encrypt each chunk (one file key, fresh IV per
 * chunk) → encode piece → SHA-256 piece ID → store replicas.
 *
 * Architectural guarantees:
 * - Encryption keys never leave the caller: they are returned alongside
 *   the manifest, never embedded in it, and never sent to storage nodes.
 * - A chunk stored on zero nodes fails the upload with a clear error;
 *   nodes that fail are simply absent from that chunk's node list.
 */

import { DEFAULT_CHUNK_SIZE, chunkData } from "../../packages/chunking/index.js";
import {
  CRYPTO_VERSION,
  encryptChunk,
  generateEncryptionKey,
} from "../../packages/crypto/index.js";
import {
  buildManifest,
  encodeEncryptedPiece,
  generateFileId,
  hashPieceId,
} from "../../packages/manifest/index.js";
import type { FileManifest, ManifestChunk } from "../../packages/manifest/index.js";
import { storePieceOnNodes } from "./index.js";
import type { StorageNodeEndpoint } from "./index.js";
import type { Registry } from "../../packages/registry/index.js";
import type { ManifestStore } from "../../packages/manifest/store.js";

/**
 * Options for {@link uploadBuffer}.
 */
export interface UploadOptions {
  chunkSize?: number;
  timeoutMs?: number;
  replicationFactor?: number;
  /** Optional registry for intelligent node selection (capacity/availability aware) */
  registry?: Registry;
  /**
   * Optional local manifest store. When provided, the resulting manifest
   * is atomically persisted via the store after a successful upload.
   * The encryption key is never persisted — only manifest metadata.
   */
  manifestStore?: ManifestStore;
}

/**
 * Result of {@link uploadBuffer}: the manifest describes the file,
 * the key decrypts it. Store the key yourself; it cannot be recovered
 * from the manifest or the nodes.
 */
export interface UploadResult {
  manifest: FileManifest;
  encryptionKey: Uint8Array;
}

/**
 * Upload a complete Buffer to the configured storage nodes.
 *
 * @param data File bytes (may be empty → manifest with zero chunks).
 * @param filename Human-readable file name recorded in the manifest.
 * @param endpoints Replica nodes; the first `replicationFactor` are used.
 * @param options Chunk size (default 4 MiB), timeout, replication factor.
 * @returns Manifest plus encryption key.
 * @throws If arguments are invalid, or when any chunk lands on zero nodes.
 */
export async function uploadBuffer(
  data: Buffer,
  filename: string,
  endpoints: StorageNodeEndpoint[],
  options: UploadOptions = {},
): Promise<UploadResult> {
  if (!Buffer.isBuffer(data)) {
    throw new TypeError("data must be a Buffer");
  }
  if (typeof filename !== "string" || filename === "") {
    throw new TypeError("filename must be a non-empty string");
  }
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const fileId = generateFileId();
  const encryptionKey = generateEncryptionKey();
  const fileChunks = chunkData(data, chunkSize);

  const manifestChunks: ManifestChunk[] = await Promise.all(
    fileChunks.map(async (fileChunk) => {
      const encrypted = encryptChunk(fileChunk.data, encryptionKey);
      const pieceBytes = encodeEncryptedPiece(encrypted);
      const pieceId = hashPieceId(pieceBytes);

      // Intelligent selection when registry is available: filter by capacity, prefer more available
      let selectedEndpoints = endpoints;
      let replicationFactor = options.replicationFactor;
      if (options.registry) {
        const { selectNodes } = await import("./selection.js");
        const candidates = options.registry.listAvailable();
        if (candidates.length > 0) {
          const rf = replicationFactor ?? 3;
          // Throws if insufficient suitable nodes — do not silently reduce
          const selected = selectNodes(candidates, pieceBytes.length, rf);
          selectedEndpoints = selected.map((r) => ({ id: r.nodeId, baseUrl: r.baseUrl }));
          replicationFactor = rf;
        }
      }

      const report = await storePieceOnNodes(pieceId, pieceBytes, selectedEndpoints, {
        timeoutMs: options.timeoutMs,
        replicationFactor,
      });
      if (report.succeeded.length === 0) {
        const reasons = report.failed
          .map(
            (failure) =>
              `${failure.endpoint.id}: ${failure.status !== undefined ? `status ${failure.status}` : failure.error}`,
          )
          .join("; ");
        throw new Error(
          `failed to store piece ${fileChunk.index} ("${pieceId}") on any node: ${reasons}`,
        );
      }
      return {
        index: fileChunk.index,
        pieceId,
        plaintextHash: fileChunk.hash,
        plaintextSize: fileChunk.data.length,
        encryptedSize: pieceBytes.length,
        nodeIds: report.succeeded.map((endpoint) => endpoint.id),
      };
    }),
  );

  const manifest = buildManifest({
    fileId,
    filename,
    size: data.length,
    chunkSize,
    cryptoVersion: CRYPTO_VERSION,
    chunks: manifestChunks,
  });
  if (options.manifestStore) {
    // Persist manifest metadata only; the key stays with the caller.
    // A persistence failure surfaces explicitly instead of silently losing the manifest.
    await options.manifestStore.save(manifest);
  }
  return { manifest, encryptionKey };
}
