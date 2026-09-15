/**
 * OpenStore Piece Integrity Verification (OPENSTORE-017)
 *
 * Client-side API to verify that a storage node still holds the
 * expected piece, without fetching plaintext/decrypted file data.
 *
 * The node confirms existence, hashes stored bytes, and compares
 * against the expected content-addressed piece ID. Only safe
 * metadata (pieceId, size, hash, verification status, node public
 * key) is returned — never encryption keys or piece contents.
 */

import { DEFAULT_TIMEOUT_MS } from "./index.js";
import type { StorageNodeEndpoint } from "./index.js";

/**
 * Options for piece verification.
 */
export interface VerifyOptions {
  timeoutMs?: number;
  /** Ed25519 identity to sign the verification request (private key stays client-side) */
  identity?: { publicKey: Buffer; privateKey: Buffer };
}

/**
 * Result of verifying one piece on one node.
 * `verified` is true only when the node holds bytes hashing to `pieceId`.
 */
export interface PieceVerification {
  version?: number;
  pieceId: string;
  size?: number;
  hash?: string;
  expectedHash?: string;
  verified: boolean;
  error?: string;
  /** Node's public key (base64) as reported by the node, when it has an identity. */
  nodeId?: string;
  publicKey?: string;
  /** Which endpoint was contacted. */
  from: StorageNodeEndpoint;
}

/**
 * Verify a single piece on a single storage node.
 *
 * @param endpoint Node to verify against.
 * @param pieceId Expected content-addressed piece ID (SHA-256 hex).
 * @param options Per-request timeout and optional signing identity.
 * @returns Verification metadata; `verified` false when the piece is
 *          missing or corrupted. Transport/auth errors throw.
 */
export async function verifyPieceOnNode(
  endpoint: StorageNodeEndpoint,
  pieceId: string,
  options: VerifyOptions = {},
): Promise<PieceVerification> {
  if (!endpoint || typeof endpoint.id !== "string" || endpoint.id === "" || typeof endpoint.baseUrl !== "string" || endpoint.baseUrl === "") {
    throw new TypeError("endpoint must be { id, baseUrl } with non-empty strings");
  }
  if (typeof pieceId !== "string" || pieceId === "") {
    throw new TypeError("pieceId must be a non-empty string");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive number");
  }

  const path = `/pieces/${encodeURIComponent(pieceId)}/verify`;
  const headers: Record<string, string> = {};
  if (options.identity) {
    const { createAuthHeaders } = await import("../../packages/auth/index.js");
    Object.assign(headers, createAuthHeaders(options.identity, "GET", path));
  }
  let res: Response;
  try {
    res = await fetch(`${normalizeBaseUrl(endpoint.baseUrl)}${path}`, {
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`verification of "${pieceId}" on node "${endpoint.id}" failed: ${toErrorMessage(err)}`);
  }
  if (res.status === 200 || res.status === 409) {
    const json = (await res.json()) as Record<string, unknown>;
    return {
      version: typeof json["version"] === "number" ? json["version"] : undefined,
      pieceId: typeof json["pieceId"] === "string" ? (json["pieceId"] as string) : pieceId,
      size: typeof json["size"] === "number" ? (json["size"] as number) : undefined,
      hash: typeof json["hash"] === "string" ? (json["hash"] as string) : undefined,
      expectedHash: typeof json["expectedHash"] === "string" ? (json["expectedHash"] as string) : undefined,
      verified: json["verified"] === true,
      error: typeof json["error"] === "string" ? (json["error"] as string) : undefined,
      nodeId: typeof json["nodeId"] === "string" ? (json["nodeId"] as string) : undefined,
      publicKey: typeof json["publicKey"] === "string" ? (json["publicKey"] as string) : undefined,
      from: endpoint,
    };
  }
  if (res.status === 404) {
    let error = "piece not found";
    try {
      const json = (await res.json()) as Record<string, unknown>;
      if (typeof json["error"] === "string") error = json["error"] as string;
    } catch {}
    return { pieceId, verified: false, error, from: endpoint };
  }
  throw new Error(`verification of "${pieceId}" on node "${endpoint.id}" failed: unexpected status ${res.status}`);
}

/**
 * Verify a piece across multiple nodes, collecting per-node results.
 * A failing node never fails the whole call.
 */
export async function verifyPieceOnNodes(
  endpoints: StorageNodeEndpoint[],
  pieceId: string,
  options: VerifyOptions = {},
): Promise<PieceVerification[]> {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new TypeError("endpoints must be a non-empty array");
  }
  return Promise.all(endpoints.map((endpoint) => verifyPieceOnNode(endpoint, pieceId, options)));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
