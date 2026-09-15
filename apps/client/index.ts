/**
 * OpenStore Multi-Node Client (OPENSTORE-004)
 *
 * Responsible for:
 * - Storing the same encrypted piece on multiple storage nodes
 * - Retrieving a piece from any healthy replica
 * - Reporting per-node success/failure without crashing on
 *   connection failures or timeouts
 *
 * MVP scope:
 * Plain HTTP against local storage nodes using Node.js stdlib only.
 * No P2P, no encryption logic (pieces are opaque bytes), no database.
 *
 * Architectural guarantees:
 * - Replication factor is configurable; the default targets every
 *   configured endpoint.
 * - A single failing node never fails the whole operation: stores
 *   report per-node results, reads fall through to the next replica.
 */

export const CLIENT_VERSION = 1;

export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Address of one storage-node replica.
 */
export interface StorageNodeEndpoint {
  id: string;
  baseUrl: string;
  /** Optional heartbeat reliability score (0–100) from registry discovery metadata. */
  reliabilityScore?: number;
  /** Optional storage-audit health score (0–100) from registry discovery metadata. */
  storageScore?: number;
}

/**
 * Options for {@link storePieceOnNodes}.
 */
export interface StorePieceOptions {
  timeoutMs?: number;
  replicationFactor?: number;
  /** Ed25519 identity to sign requests (private key stays client-side) */
  identity?: { publicKey: Buffer; privateKey: Buffer };
}

/**
 * A single node that did not store the piece.
 */
export interface NodeFailure {
  endpoint: StorageNodeEndpoint;
  status?: number;
  error: string;
}

/**
 * Versioned result of a replicated store.
 */
export interface StorePiecesReport {
  version: number;
  pieceId: string;
  size: number;
  succeeded: StorageNodeEndpoint[];
  failed: NodeFailure[];
}

/**
 * Options for {@link getPieceFromNodes}.
 */
export interface GetPieceOptions {
  timeoutMs?: number;
  /** Ed25519 identity to sign requests */
  identity?: { publicKey: Buffer; privateKey: Buffer };
}

/**
 * A piece retrieved from one of the configured replicas.
 */
export interface RetrievedPiece {
  bytes: Buffer;
  from: StorageNodeEndpoint;
}

/**
 * Send a piece to the configured nodes and report per-node results.
 * The first `replicationFactor` endpoints are targeted (defaults to all).
 * Node failures and timeouts are collected, never thrown.
 *
 * @param pieceId Piece ID accepted by the storage-node API.
 * @param data Opaque piece bytes (treated as-is, never inspected).
 * @param endpoints Replica nodes to write to.
 * @param options Per-request timeout and replication factor.
 * @returns Versioned report of succeeded/failed nodes.
 * @throws If arguments are invalid (empty piece ID, non-Buffer data,
 *         empty endpoint list, bad timeout, bad replication factor).
 */
export async function storePieceOnNodes(
  pieceId: string,
  data: Buffer,
  endpoints: StorageNodeEndpoint[],
  options: StorePieceOptions = {},
): Promise<StorePiecesReport> {
  assertValidPieceIdArg(pieceId);
  assertValidData(data);
  assertValidEndpoints(endpoints);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertValidTimeout(timeoutMs);
  const replicationFactor = options.replicationFactor ?? endpoints.length;
  if (!Number.isInteger(replicationFactor) || replicationFactor <= 0) {
    throw new RangeError("replicationFactor must be a positive integer");
  }

  const selected = endpoints.slice(
    0,
    Math.min(replicationFactor, endpoints.length),
  );
  const body = JSON.stringify({ id: pieceId, data: data.toString("base64") });

  const succeeded: StorageNodeEndpoint[] = [];
  const failed: NodeFailure[] = [];
  await Promise.all(
    selected.map(async (endpoint) => {
      const failure = await postToNode(endpoint, body, timeoutMs, options.identity);
      if (failure === null) {
        succeeded.push(endpoint);
      } else {
        failed.push(failure);
      }
    }),
  );

  return {
    version: CLIENT_VERSION,
    pieceId,
    size: data.length,
    succeeded,
    failed,
  };
}

/**
 * Delete a piece from a set of nodes (best-effort, never throws).
 * Used to clean up partially stored uploads — only deletes pieceIds
 * that belong to the failed file, never other files.
 */
export async function deletePieceFromNodes(
  pieceId: string,
  endpoints: StorageNodeEndpoint[],
  options: GetPieceOptions = {},
): Promise<void> {
  assertValidPieceIdArg(pieceId);
  if (!Array.isArray(endpoints) || endpoints.length === 0) return;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const path = `/pieces/${encodeURIComponent(pieceId)}`;
        const headers: Record<string, string> = {};
        if (options.identity) {
          const { createAuthHeaders } = await import("../../packages/auth/index.js");
          Object.assign(headers, createAuthHeaders(options.identity, "DELETE", path));
        }
        await fetch(`${normalizeBaseUrl(endpoint.baseUrl)}${path}`, {
          method: "DELETE",
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {}
    }),
  );
}

/**
 * Whether an error message looks like a transient network/5xx failure
 * that is worth retrying. Permanent failures (400, 404, 413, 507 quota,
 * draining, auth) are never retried.
 */
export function isTransientError(message: string): boolean {
  const lower = message.toLowerCase();
  if (/507|413|400|401|404|insufficient storage|draining|quota|invalid piece|invalid file id|malformed/i.test(lower)) return false;
  return /timeout|network|econn|eai_again|ecanceled|aborted|fetch failed|500|502|503|504|unavailable|failed to store piece|unreachable/i.test(lower);
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Retrieve a piece by trying each configured replica in order until
 * one returns the bytes. Unreachable nodes and error statuses are
 * skipped; only total failure throws. Transient failures are retried
 * once with backoff before moving to the next replica.
 *
 * @param pieceId Piece ID to fetch.
 * @param endpoints Replica nodes to try in order.
 * @param options Per-request timeout.
 * @returns The bytes plus which replica served them.
 * @throws If arguments are invalid, or when no replica serves the piece.
 */
export async function getPieceFromNodes(
  pieceId: string,
  endpoints: StorageNodeEndpoint[],
  options: GetPieceOptions = {},
): Promise<RetrievedPiece> {
  assertValidPieceIdArg(pieceId);
  assertValidEndpoints(endpoints);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertValidTimeout(timeoutMs);

  const problems: string[] = [];
  for (const endpoint of endpoints) {
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const path = `/pieces/${encodeURIComponent(pieceId)}`;
        const headers: Record<string, string> = {};
        if (options.identity) {
          const { createAuthHeaders } = await import("../../packages/auth/index.js");
          Object.assign(headers, createAuthHeaders(options.identity, "GET", path));
        }
        const res = await fetch(
          `${normalizeBaseUrl(endpoint.baseUrl)}${path}`,
          {
            headers: Object.keys(headers).length > 0 ? headers : undefined,
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (res.status === 200) {
          return {
            bytes: Buffer.from(await res.arrayBuffer()),
            from: endpoint,
          };
        }
        if (res.status >= 500 && res.status !== 507 && attempt === 0) {
          lastErr = `${endpoint.id}: unexpected status ${res.status}`;
          await delay(100 * (attempt + 1));
          continue;
        }
        problems.push(`${endpoint.id}: unexpected status ${res.status}`);
        lastErr = null;
        break;
      } catch (err) {
        const msg = toErrorMessage(err);
        if (isTransientError(msg) && attempt === 0) {
          lastErr = `${endpoint.id}: ${msg}`;
          await delay(100 * (attempt + 1));
          continue;
        }
        problems.push(`${endpoint.id}: ${msg}`);
        lastErr = null;
        break;
      }
    }
    if (lastErr) problems.push(lastErr);
  }
  throw new Error(
    `piece "${pieceId}" unavailable from ${endpoints.length} node(s): ${problems.join("; ")}`,
  );
}

async function postToNode(
  endpoint: StorageNodeEndpoint,
  body: string,
  timeoutMs: number,
  identity?: { publicKey: Buffer; privateKey: Buffer },
): Promise<NodeFailure | null> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (identity) {
      const { createAuthHeaders } = await import("../../packages/auth/index.js");
      Object.assign(headers, createAuthHeaders(identity, "POST", "/pieces", Buffer.from(body, "utf8")));
    }
    const res = await fetch(`${normalizeBaseUrl(endpoint.baseUrl)}/pieces`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 200 || res.status === 201) {
      return null;
    }
    return {
      endpoint,
      status: res.status,
      error: `unexpected status ${res.status}`,
    };
  } catch (err) {
    return { endpoint, error: toErrorMessage(err) };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertValidPieceIdArg(pieceId: string): void {
  if (typeof pieceId !== "string" || pieceId.length === 0) {
    throw new TypeError("pieceId must be a non-empty string");
  }
}

function assertValidData(data: Buffer): void {
  if (!Buffer.isBuffer(data)) {
    throw new TypeError("data must be a Buffer");
  }
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
      throw new TypeError(
        `endpoints[${i}] must be { id, baseUrl } with non-empty strings`,
      );
    }
  }
}

function assertValidTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive number");
  }
}
