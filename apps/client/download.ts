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
import type { StorageNodeEndpoint } from "./index.js";

/**
 * Options for {@link downloadBuffer}.
 */
export interface DownloadOptions {
  timeoutMs?: number;
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
      const { bytes } = await getPieceFromNodes(chunk.pieceId, endpoints, {
        timeoutMs: options.timeoutMs,
      });
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
      return {
        version: CHUNKING_VERSION,
        index: chunk.index,
        total: checked.totalChunks,
        data,
        hash: chunk.plaintextHash,
      };
    }),
  );

  return reassembleChunks(fileChunks);
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
