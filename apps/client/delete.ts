/**
 * OpenStore Remote File Deletion (OPENSTORE-021)
 *
 * Deletes a stored file's encrypted pieces from all known replica nodes,
 * then removes its local manifest — and only then.
 *
 * Flow guarantees:
 * - For every manifest piece, DELETE is sent to every known replica node
 *   using the existing Ed25519 request signing when an identity is given.
 * - A missing piece (404) counts as already deleted, not as a failure.
 * - Any unresolved failure produces a clear partial-failure result via
 *   {@link DeleteFileError} (never silent success). The local manifest
 *   is removed only when every deletion succeeded or was confirmed
 *   already absent.
 * - No plaintext, encryption keys, or private keys are handled here;
 *   the manifest is revalidated before use and key material is rejected.
 */

import {
  MANIFEST_VERSION,
  buildManifest,
} from "../../packages/manifest/index.js";
import type { FileManifest } from "../../packages/manifest/index.js";
import type { ManifestStore } from "../../packages/manifest/store.js";
import { DEFAULT_TIMEOUT_MS } from "./index.js";
import type { StorageNodeEndpoint } from "./index.js";
import type { CoordinatorEndpointProvider } from "./index.js";
import { resolveEndpoints } from "./coordinator.js";
import type { P2PTransport } from "../../packages/p2p/index.js";
import { MixedStorageTransport, HttpStorageTransport } from "./http-transport.js";

export const DELETE_VERSION = 1;

/**
 * Options for {@link deleteFile}.
 */
export interface DeleteFileOptions {
  timeoutMs?: number;
  /** Ed25519 identity to sign DELETE requests (private key stays client-side) */
  identity?: { publicKey: Buffer; privateKey: Buffer };
  /**
   * Optional local manifest store. The manifest is removed only after
   * every piece deletion succeeded or was confirmed already absent.
   */
  manifestStore?: ManifestStore;
  /** Discover endpoints from a coordinator when endpoints is empty. */
  coordinator?: CoordinatorEndpointProvider;
  transport?: P2PTransport;
}

/**
 * One piece deletion that succeeded or was already absent.
 */
export interface DeletedPiece {
  endpoint: StorageNodeEndpoint;
  pieceId: string;
}

/**
 * One piece deletion that could not be completed.
 */
export interface DeleteFailure {
  endpoint: StorageNodeEndpoint;
  pieceId: string;
  status?: number;
  error: string;
}

/**
 * Versioned result of a file deletion.
 */
export interface DeleteFileReport {
  version: number;
  fileId: string;
  /** Number of chunks (pieces) in the manifest. */
  totalPieces: number;
  /** Deletions confirmed by the node (204/200). */
  deleted: DeletedPiece[];
  /** Pieces already absent on the node (404). */
  alreadyAbsent: DeletedPiece[];
  /** Deletions that could not be completed. Empty on full success. */
  failed: DeleteFailure[];
  /** True when the local manifest was removed via `manifestStore`. */
  manifestRemoved: boolean;
}

/**
 * Error thrown when some piece deletions fail.
 * Carries the full {@link DeleteFileReport} for inspection.
 */
export class DeleteFileError extends Error {
  readonly report: DeleteFileReport;

  constructor(report: DeleteFileReport) {
    const details = report.failed
      .map((f) => `${f.endpoint.id} / ${f.pieceId}: ${f.status !== undefined ? `status ${f.status}` : f.error}`)
      .join("; ");
    super(
      `failed to delete file "${report.fileId}": ${report.failed.length} deletion(s) failed: ${details}`,
    );
    this.name = "DeleteFileError";
    this.report = report;
  }
}

/**
 * Delete a file's pieces from all known replica nodes.
 *
 * @param manifest File manifest from {@link uploadBuffer} (revalidated here).
 * @param endpoints Replica nodes holding the pieces.
 * @param options Per-request timeout, signing identity, manifest store.
 * @returns Report when every deletion succeeded or was already absent.
 * @throws {@link DeleteFileError} on partial failure (manifest kept),
 *         or on invalid arguments / manifest validation failure.
 */
export async function deleteFile(
  manifest: FileManifest,
  endpoints: StorageNodeEndpoint[],
  options: DeleteFileOptions = {},
): Promise<DeleteFileReport> {
  const checked = revalidateManifest(manifest);
  endpoints = await resolveEndpoints(endpoints, options.coordinator);
  assertValidEndpoints(endpoints);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive number");
  }

  const deleted: DeletedPiece[] = [];
  const alreadyAbsent: DeletedPiece[] = [];
  const failed: DeleteFailure[] = [];
  const transport = options.transport ?? new MixedStorageTransport(new HttpStorageTransport(options.identity));

  await Promise.all(
    checked.chunks.flatMap((chunk) =>
      endpoints.map(async (endpoint) => {
        const outcome = await deletePieceOnNode(endpoint, chunk.pieceId, timeoutMs, options.identity, transport);
        if (outcome === "deleted") {
          deleted.push({ endpoint, pieceId: chunk.pieceId });
        } else if (outcome === "absent") {
          alreadyAbsent.push({ endpoint, pieceId: chunk.pieceId });
        } else {
          failed.push({ endpoint, pieceId: chunk.pieceId, ...outcome });
        }
      }),
    ),
  );

  const report: DeleteFileReport = {
    version: DELETE_VERSION,
    fileId: checked.fileId,
    totalPieces: checked.chunks.length,
    deleted,
    alreadyAbsent,
    failed,
    manifestRemoved: false,
  };

  if (failed.length > 0) {
    // Unresolved failures: keep the local manifest and fail loudly.
    throw new DeleteFileError(report);
  }

  if (options.manifestStore) {
    await options.manifestStore.delete(checked.fileId);
    report.manifestRemoved = true;
  }
  return report;
}

type DeleteOutcome = "deleted" | "absent" | { status?: number; error: string };

async function deletePieceOnNode(
  endpoint: StorageNodeEndpoint,
  pieceId: string,
  timeoutMs: number,
  identity?: { publicKey: Buffer; privateKey: Buffer },
  transport?: P2PTransport,
): Promise<DeleteOutcome> {
  const path = `/pieces/${encodeURIComponent(pieceId)}`;
  try {
    if (transport) {
      const res = await transport.deletePiece({
        nodeId: endpoint.id,
        baseUrl: endpoint.baseUrl,
        ...(endpoint.multiaddr === undefined ? {} : { multiaddr: endpoint.multiaddr }),
        ...(endpoint.identityBinding === undefined ? {} : { identityBinding: endpoint.identityBinding }),
        ...(endpoint.identity === undefined ? {} : { identity: endpoint.identity }),
      }, pieceId, { timeoutMs });
      if (res.status === 204 || res.status === 200) return "deleted";
      if (res.status === 404) return "absent";
      return { status: res.status, error: `unexpected status ${res.status}` };
    }
    const headers: Record<string, string> = {};
    if (identity) {
      const { createAuthHeaders } = await import("../../packages/auth/index.js");
      Object.assign(headers, createAuthHeaders(identity, "DELETE", path));
    }
    const res = await fetch(`${normalizeBaseUrl(endpoint.baseUrl)}${path}`, {
      method: "DELETE",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204 || res.status === 200) return "deleted";
    if (res.status === 404) return "absent";
    return { status: res.status, error: `unexpected status ${res.status}` };
  } catch (err) {
    return { error: toErrorMessage(err) };
  }
}

function revalidateManifest(manifest: FileManifest): FileManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("manifest must be an object");
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`unsupported manifest version: ${(manifest as FileManifest).version}`);
  }
  // Rebuilds + validates ordering/hashes and rejects key material.
  return buildManifest({
    fileId: manifest.fileId,
    filename: manifest.filename,
    size: manifest.size,
    chunkSize: manifest.chunkSize,
    cryptoVersion: manifest.cryptoVersion,
    chunks: manifest.chunks,
  });
}

function assertValidEndpoints(endpoints: StorageNodeEndpoint[]): void {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new TypeError("endpoints must be a non-empty array");
  }
  for (let i = 0; i < endpoints.length; i += 1) {
    const endpoint = endpoints[i] as StorageNodeEndpoint;
    if (
      !endpoint ||
      typeof endpoint.id !== "string" ||
      endpoint.id === "" ||
      typeof endpoint.baseUrl !== "string" ||
      endpoint.baseUrl === ""
    ) {
      throw new TypeError(`endpoints[${i}] must be { id, baseUrl } with non-empty strings`);
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
