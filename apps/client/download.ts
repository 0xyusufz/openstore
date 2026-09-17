/**
 * OpenStore Download Pipeline (OPENSTORE-006)
 *
 * Responsible for:
 * - Reconstructing a file from its manifest, encryption key, and
 *   replicated storage nodes (the reverse of the upload flow)
 *
 * MVP flow per file:
 * manifest → fetch each piece via any healthy replica → verify piece
 * SHA-256 → decode piece → decrypt chunk → verify plaintext hash and
 * size → reassemble chunks in original order.
 *
 * Architectural guarantees:
 * - Unhealthy replicas are skipped automatically; a piece missing from
 *   every replica fails the download with a clear error.
 * - Corrupted or substituted bytes never become file data: every layer
 *   (piece hash, envelope, GCM auth, plaintext hash/size) is verified.
 */

import {
  CHUNKING_VERSION,
  reassembleChunks,
} from "../../packages/chunking/index.js";
import type { FileChunk } from "../../packages/chunking/index.js";
import { CRYPTO_VERSION, decryptChunk } from "../../packages/crypto/index.js";
import {
  MANIFEST_VERSION,
  buildManifest,
  decodeEncryptedPiece,
  hashPieceId,
} from "../../packages/manifest/index.js";
import type { FileManifest } from "../../packages/manifest/index.js";
import { getPieceFromNodes } from "./index.js";
import { assertValidEndpoints } from "./index.js";
import type { StorageNodeEndpoint } from "./index.js";
import type { CoordinatorEndpointProvider } from "./index.js";
import { resolveEndpoints, resolveManifestReplicaEndpoints } from "./coordinator.js";
import type { P2PTransport } from "../../packages/p2p/index.js";
import type { MetricsRegistry } from "../../packages/metrics/index.js";

/**
 * Options for {@link downloadBuffer}.
 */
export interface DownloadOptions {
  timeoutMs?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
  /** Discover endpoints from a coordinator when endpoints is empty. */
  coordinator?: CoordinatorEndpointProvider;
  transport?: P2PTransport;
  identity?: { publicKey: Buffer; privateKey: Buffer };
  metrics?: MetricsRegistry;
}

/**
 * Reconstruct a file from its manifest and encryption key.
 *
 * @param manifest File manifest from {@link uploadBuffer}.
 * @param encryptionKey File key returned alongside the manifest.
 * @param endpoints Replica nodes to fetch pieces from, in order.
 * @param options Per-request timeout.
 * @returns Original file bytes.
 * @throws If the manifest/key/endpoints are invalid, a piece is
 *         unavailable everywhere, bytes fail verification, or
 *         decryption fails (e.g. wrong key).
 */
export async function downloadBuffer(
  manifest: FileManifest,
  encryptionKey: Uint8Array,
  endpoints: StorageNodeEndpoint[],
  options: DownloadOptions = {},
): Promise<Buffer> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("manifest must be an object");
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`unsupported manifest version: ${manifest.version}`);
  }
  if (manifest.cryptoVersion !== CRYPTO_VERSION) {
    throw new Error(`unsupported crypto version: ${manifest.cryptoVersion}`);
  }
  if (!(encryptionKey instanceof Uint8Array)) {
    throw new TypeError("encryption key must be a Uint8Array");
  }
  // Existing files may use the last-known endpoint catalog during an outage;
  // they must not trigger discovery of new replicas.
  endpoints = endpoints.length === 0 && options.coordinator
    ? (options.coordinator.getKnownEndpoints?.() ?? options.coordinator.getEndpoints())
    : await resolveEndpoints(endpoints, undefined);
  assertValidEndpoints(endpoints);

  // Reuse manifest validation (ordering, hashes, no key material).
  const checked = buildManifest({
    fileId: manifest.fileId,
    filename: manifest.filename,
    size: manifest.size,
    chunkSize: manifest.chunkSize,
    cryptoVersion: manifest.cryptoVersion,
    chunks: manifest.chunks,
  });

  const fileChunks: FileChunk[] = await Promise.all(
    checked.chunks.map(async (chunk) => {
      // Try every replica in order with FULL verification per replica.
      // Transport failures fall through via getPieceFromNodes, while
      // integrity failures (hash/envelope/decrypt/size) move to the
      // next replica instead of failing the whole download. A corrupt
      // piece is never accepted just because a request succeeded.
      const problems: string[] = [];
      const replicas = resolveManifestReplicaEndpoints(checked, endpoints, chunk);
      for (const endpoint of replicas) {
        let bytes: Buffer;
        try {
          const got = await getPieceFromNodes(chunk.pieceId, [endpoint], {
            timeoutMs: options.timeoutMs,
            retryAttempts: options.retryAttempts,
            retryBackoffMs: options.retryBackoffMs,
            transport: options.transport,
            identity: options.identity,
            metrics: options.metrics,
          });
          bytes = got.bytes;
        } catch (err) {
          problems.push(`${endpoint.id}: ${toErrorMessage(err)}`);
          continue;
        }
        try {
          const data = verifyChunkBytes(chunk, bytes, encryptionKey);
          return {
            version: CHUNKING_VERSION,
            index: chunk.index,
            total: checked.totalChunks,
            data,
            hash: chunk.plaintextHash,
          };
        } catch (err) {
          problems.push(`${endpoint.id}: ${toErrorMessage(err)}`);
          continue;
        }
      }
      throw new Error(
        `piece ${chunk.index} ("${chunk.pieceId}") failed on all ${replicas.length} replica(s): ${problems.join("; ")}`,
      );
    }),
  );

  return reassembleChunks(fileChunks);
}

/**
 * Verify fetched piece bytes against every manifest check for one chunk:
 * piece ID/hash, envelope decoding, authenticated decryption, plaintext
 * size, plaintext hash, and chunk index/order metadata.
 *
 * @throws With the same specific messages callers already rely on
 *         (hash mismatch, decryption failed, size mismatch, ...).
 */
function verifyChunkBytes(
  chunk: { index: number; pieceId: string; plaintextHash: string; plaintextSize: number },
  bytes: Buffer,
  encryptionKey: Uint8Array,
): Buffer {
  if (hashPieceId(bytes) !== chunk.pieceId) {
    throw new Error(
      `piece ${chunk.index} ("${chunk.pieceId}") hash mismatch: stored bytes do not match manifest`,
    );
  }
  const encrypted = decodeEncryptedPiece(bytes);
  let plaintext: Uint8Array;
  try {
    plaintext = decryptChunk(encrypted, encryptionKey);
  } catch (err) {
    throw new Error(
      `piece ${chunk.index} ("${chunk.pieceId}") decryption failed: ${toErrorMessage(err)}`,
    );
  }
  const data = Buffer.from(plaintext);
  if (data.length !== chunk.plaintextSize) {
    throw new Error(
      `piece ${chunk.index} ("${chunk.pieceId}") plaintext size mismatch: expected ${chunk.plaintextSize}, got ${data.length}`,
    );
  }
  if (hashPieceId(data) !== chunk.plaintextHash) {
    throw new Error(
      `piece ${chunk.index} ("${chunk.pieceId}") plaintext hash mismatch: decrypted bytes do not match manifest`,
    );
  }
  return data;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
