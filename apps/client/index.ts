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

import { createHash } from "crypto";
import { HttpStorageTransport } from "./http-transport.js";
import { MixedStorageTransport } from "./http-transport.js";
import type { P2PTransport } from "../../packages/p2p/index.js";
import type { P2PNodeAddress, P2PNodeIdentity } from "../../packages/p2p/index.js";
import { defaultMetrics, type MetricsRegistry } from "../../packages/metrics/index.js";

export const CLIENT_VERSION = 1;

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 25;
/** Maximum caller-configurable attempts for one node operation. */
export const MAX_RETRY_ATTEMPTS = 10;
/** Maximum base and per-attempt exponential backoff delay in milliseconds. */
export const MAX_RETRY_BACKOFF_MS = 1000;

/**
 * Address of one storage-node replica.
 */
export interface StorageNodeEndpoint {
  id: string;
  baseUrl: string;
  /** Transport advertised by the coordinator. */
  transport?: "http" | "libp2p";
  /** Capacity metadata advertised by the coordinator. */
  capacity?: {
    allocatedBytes?: number;
    totalBytes?: number;
    usedBytes: number;
    availableBytes: number;
  };
  /** Capability metadata advertised by the coordinator. */
  capabilities?: {
    pieceStore: boolean;
    pieceGet: boolean;
    pieceDelete: boolean;
    maxPieceBytes?: number;
  };
  /** Static libp2p address for libp2p:// endpoints. */
  multiaddr?: string;
  /** Public OpenStore-to-libp2p identity binding. */
  identityBinding?: string;
  identity?: P2PNodeIdentity;
  /** Optional heartbeat reliability score (0–100) from registry discovery metadata. */
  reliabilityScore?: number;
  /** Optional storage-audit health score (0–100) from registry discovery metadata. */
  storageScore?: number;
}

/** A source of coordinator-discovered storage endpoints. */
export interface CoordinatorEndpointProvider {
  refresh(): Promise<StorageNodeEndpoint[]>;
  getEndpoints(): StorageNodeEndpoint[];
  /** Optional all-record snapshot, including unavailable nodes. */
  getKnownEndpoints?: () => StorageNodeEndpoint[];
  /** Optional bounded freshness/capability state. */
  readonly discovery?: import("../../packages/discovery-state/index.js").DiscoveryCapabilitySnapshot;
}

/**
 * Options for {@link storePieceOnNodes}.
 */
export interface StorePieceOptions {
  timeoutMs?: number;
  replicationFactor?: number;
  /** Ed25519 identity to sign requests (private key stays client-side) */
  identity?: { publicKey: Buffer; privateKey: Buffer };
  retryAttempts?: number;
  retryBackoffMs?: number;
  transport?: P2PTransport;
  metrics?: MetricsRegistry;
}

/**
 * A single node that did not store the piece.
 */
export interface NodeFailure {
  endpoint: StorageNodeEndpoint;
  status?: number;
  error: string;
  classification?: "transient" | "permanent" | "unavailable";
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
  retryAttempts?: number;
  retryBackoffMs?: number;
  /** Optional integrity check; invalid responses are treated as replica failures. */
  validate?: (bytes: Buffer, endpoint: StorageNodeEndpoint) => void | Promise<void>;
  transport?: P2PTransport;
  metrics?: MetricsRegistry;
}

/**
 * A piece retrieved from one of the configured replicas.
 */
export interface RetrievedPiece {
  bytes: Buffer;
  from: StorageNodeEndpoint;
}

const inFlightStores = new Map<string, Promise<StorePiecesReport>>();

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
  assertValidRetryOptions(options.retryAttempts, options.retryBackoffMs);
  const replicationFactor = options.replicationFactor ?? endpoints.length;
  if (!Number.isInteger(replicationFactor) || replicationFactor <= 0) {
    throw new RangeError("replicationFactor must be a positive integer");
  }
  const operationKey = buildStoreOperationKey(pieceId, data, endpoints, {
    timeoutMs,
    replicationFactor,
    retryAttempts: options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
    retryBackoffMs: options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
    publicKey: options.identity?.publicKey.toString("base64") ?? "",
    protocol: options.transport?.protocol ?? "http",
  });
  const existing = inFlightStores.get(operationKey);
  if (existing) return existing;
  const metrics = options.metrics ?? defaultMetrics;
  metrics.increment("client_uploads_total", 1, { result: "success" });
  const operation = storePieceOnNodesUncoordinated(pieceId, data, endpoints, options);
  inFlightStores.set(operationKey, operation);
  try {
    const result = await operation;
    metrics.increment("client_replica_failures_total", result.failed.length, { result: result.failed.length ? "error" : "success" });
    return result;
  } finally {
    if (inFlightStores.get(operationKey) === operation) inFlightStores.delete(operationKey);
  }
}

async function storePieceOnNodesUncoordinated(
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
  assertValidRetryOptions(options.retryAttempts, options.retryBackoffMs);
  const replicationFactor = options.replicationFactor ?? endpoints.length;
  if (!Number.isInteger(replicationFactor) || replicationFactor <= 0) {
    throw new RangeError("replicationFactor must be a positive integer");
  }

  const selected = endpoints.slice(
    0,
    endpoints.length,
  );
  const succeeded: StorageNodeEndpoint[] = [];
  const failed: NodeFailure[] = [];
  const transport = options.transport ?? new MixedStorageTransport(new HttpStorageTransport(options.identity));
  for (const endpoint of selected) {
    if (succeeded.length >= Math.min(replicationFactor, endpoints.length)) break;
    const failure = await postToNode(endpoint, pieceId, data, timeoutMs, transport, options);
    if (failure === null) succeeded.push(endpoint);
    else failed.push(failure);
  }

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
  const transport = options.transport ?? new MixedStorageTransport(new HttpStorageTransport(options.identity));
  await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        await transport.deletePiece(toP2PAddress(endpoint), pieceId, { timeoutMs });
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
  assertValidRetryOptions(options.retryAttempts, options.retryBackoffMs);

  const problems: string[] = [];
  const transport = options.transport ?? new MixedStorageTransport(new HttpStorageTransport(options.identity));
  for (const endpoint of endpoints) {
    const attempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await transport.getPiece(toP2PAddress(endpoint), pieceId, { timeoutMs });
        if (res.status === 200 && res.bytes) {
          const bytes = res.bytes;
          try {
            await options.validate?.(bytes, endpoint);
            (options.metrics ?? defaultMetrics).increment("client_downloads_total", 1, { result: "success" });
            return { bytes, from: endpoint };
          } catch (err) {
            problems.push(`${endpoint.id}: ${toErrorMessage(err)}`);
            break;
          }
        }
        problems.push(`${endpoint.id}: unexpected status ${res.status}`);
        if (!isTransientStatus(res.status)) break;
      } catch (err) {
        problems.push(`${endpoint.id}: ${toErrorMessage(err)}`);
      }
      if (attempt + 1 < attempts) (options.metrics ?? defaultMetrics).increment("client_retries_total", 1, { operation: "get", result: "error" });
      if (attempt + 1 < attempts) await backoff(options.retryBackoffMs, attempt);
    }
    (options.metrics ?? defaultMetrics).increment("client_download_errors_total", 1, { result: "error" });
  }
  throw new Error(
    `piece "${pieceId}" unavailable from ${endpoints.length} node(s): ${problems.join("; ")}`,
  );
}

async function postToNode(
  endpoint: StorageNodeEndpoint,
  pieceId: string,
  data: Buffer,
  timeoutMs: number,
  transport: P2PTransport,
  options: StorePieceOptions = {},
): Promise<NodeFailure | null> {
  const attempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  let last: NodeFailure | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
   try {
    const res = await transport.storePiece(toP2PAddress(endpoint), pieceId, data, { timeoutMs });
    if (res.status === 200 || res.status === 201) {
      return null;
    }
    last = {
      endpoint,
      status: res.status,
      error: `unexpected status ${res.status}`,
      classification: isTransientStatus(res.status) ? "transient" : res.status === 404 ? "unavailable" : "permanent",
    };
    if (!isTransientStatus(res.status)) return last;
  } catch (err) {
    last = { endpoint, error: toErrorMessage(err), classification: "transient" };
  }
   if (attempt + 1 < attempts) await backoff(options.retryBackoffMs, attempt);
  }
  return last;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function backoff(base: number | undefined, attempt: number): Promise<void> {
  const delay = Math.min(
    MAX_RETRY_BACKOFF_MS,
    Math.max(0, base ?? DEFAULT_RETRY_BACKOFF_MS) * 2 ** attempt,
  );
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

function buildStoreOperationKey(
  pieceId: string,
  data: Buffer,
  endpoints: StorageNodeEndpoint[],
  options: {
    timeoutMs: number;
    replicationFactor: number;
    retryAttempts: number;
    retryBackoffMs: number;
    publicKey: string;
    protocol: string;
  },
): string {
  const dataDigest = createHash("sha256").update(data).digest("hex");
  const endpointSet = endpoints.map(({ id, baseUrl }) => ({ id, baseUrl }));
  return createHash("sha256")
    .update(JSON.stringify({ pieceId, dataDigest, endpointSet, ...options }))
    .digest("hex");
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toP2PAddress(endpoint: StorageNodeEndpoint): P2PNodeAddress {
  return {
    nodeId: endpoint.id,
    baseUrl: endpoint.baseUrl,
    ...(endpoint.multiaddr === undefined ? {} : { multiaddr: endpoint.multiaddr }),
    ...(endpoint.identityBinding === undefined ? {} : { identityBinding: endpoint.identityBinding }),
    ...(endpoint.identity === undefined ? {} : { identity: endpoint.identity }),
  } as P2PNodeAddress;
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

export function assertValidEndpoints(endpoints: StorageNodeEndpoint[]): void {
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
    const expected = endpoint.baseUrl.startsWith("libp2p:") ? "libp2p" :
      endpoint.baseUrl.startsWith("http:") || endpoint.baseUrl.startsWith("https:") ? "http" : undefined;
    if (!expected) throw new TypeError(`endpoints[${i}] has an unsupported transport`);
    if (endpoint.transport !== undefined && endpoint.transport !== expected) {
      throw new TypeError(`endpoints[${i}] transport does not match baseUrl`);
    }
    try {
      const parsed = new URL(endpoint.baseUrl);
      if (parsed.username || parsed.password) throw new Error("credentials");
    } catch {
      throw new TypeError(`endpoints[${i}] baseUrl is invalid`);
    }
    if (endpoint.capabilities !== undefined) {
      for (const capability of ["pieceStore", "pieceGet", "pieceDelete"] as const) {
        if (typeof endpoint.capabilities[capability] !== "boolean") {
          throw new TypeError(`endpoints[${i}] capability ${capability} is invalid`);
        }
      }
      if (endpoint.capabilities.maxPieceBytes !== undefined &&
        (!Number.isSafeInteger(endpoint.capabilities.maxPieceBytes) || endpoint.capabilities.maxPieceBytes <= 0)) {
        throw new TypeError(`endpoints[${i}] maxPieceBytes is invalid`);
      }
    }
    if (endpoint.baseUrl.startsWith("libp2p:")) {
      if (typeof endpoint.multiaddr !== "string" || endpoint.multiaddr.length === 0) {
        throw new TypeError(`endpoints[${i}] libp2p endpoints require multiaddr`);
      }
      if (endpoint.identityBinding !== undefined && endpoint.identityBinding !== endpoint.id) {
        throw new TypeError(`endpoints[${i}] has an invalid identity binding`);
      }
    }
  }
  const ids = new Set(endpoints.map((endpoint) => endpoint.id));
  if (ids.size !== endpoints.length) {
    throw new TypeError("endpoints must contain distinct node identities");
  }
}

function assertValidTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive number");
  }
}

function assertValidRetryOptions(attempts: number | undefined, backoffMs: number | undefined): void {
  if (
    attempts !== undefined &&
    (!Number.isInteger(attempts) || attempts <= 0 || attempts > MAX_RETRY_ATTEMPTS)
  ) {
    throw new RangeError(`retryAttempts must be an integer from 1 to ${MAX_RETRY_ATTEMPTS}`);
  }

  if (
    backoffMs !== undefined &&
    (!Number.isFinite(backoffMs) || backoffMs < 0 || backoffMs > MAX_RETRY_BACKOFF_MS)
  ) {
    throw new RangeError(
      `retryBackoffMs must be a number from 0 to ${MAX_RETRY_BACKOFF_MS}`,
    );
  }
}

export { createCoordinatorAdapter, coordinatorNodesToEndpoints, resolveEndpoints } from "./coordinator.js";
export {
  clientNamespace,
  createPieceClaim,
  createClaimOnNode,
  storeClaimedPieceOnNode,
  markClaimReferencedOnNode,
  releaseClaimOnNode,
  deletePieceIfUnclaimedOnNode,
  createOperationRecord,
  createOperationRecordStore,
  reconcileCommittedOperation,
  storePieceWithProvenance,
  reconcileDeletedProvenanceOperations,
} from "./provenance.js";
