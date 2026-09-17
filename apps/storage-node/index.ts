/**
 * OpenStore Storage Node (MVP)
 *
 * Responsible for:
 * - Storing opaque encrypted pieces on local disk
 * - Retrieving pieces by piece ID
 * - Reporting piece existence
 * - Deleting pieces
 *
 * MVP transport:
 * Plain HTTP over localhost using Node.js stdlib only.
 *
 * Architectural guarantees:
 * - The node never accepts or handles encryption keys; POST bodies
 *   containing key material are rejected. Stored data is treated as
 *   opaque bytes and returned unchanged.
 * - Piece IDs are restricted to a safe charset so they can never
 *   escape the storage directory (no path traversal).
 * - Duplicate stores overwrite: last-write-wins. POST returns 201
 *   when a piece is created and 200 when an existing piece is
 *   overwritten.
 */

import { createHash } from "crypto";
import { createServer } from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { DEFAULT_MAX_CLOCK_SKEW_MS, DEFAULT_MAX_REPLAY_CACHE_ENTRIES, PUBKEY_HEADER, verifyAuthHeaders } from "../../packages/auth/index.js";
import type { Identity } from "../../packages/identity/index.js";
import type { Registry } from "../../packages/registry/index.js";
import { createPieceProvenanceStore, type PieceProvenanceStore } from "./provenance-store.js";
import { createOrphanScanner, type OrphanScanner } from "./orphan-scanner.js";
import type { PieceClaim } from "../../packages/provenance/index.js";
import { hashPieceId } from "../../packages/manifest/index.js";
import { safeErrorMessage } from "./safe-error.js";
import { defaultMetrics, type MetricsRegistry } from "../../packages/metrics/index.js";
import { defaultEvents, type EventStore } from "../../packages/events/index.js";

export const STORAGE_NODE_VERSION = 1;

const MAX_PIECE_ID_LENGTH = 128;
const PIECE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_CAPACITY_BYTES = 1 * 1024 * 1024 * 1024;
/** JSON/base64 framing needs more room than a raw piece; this is independent of quota. */
export const DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Options for {@link createStorageNode}.
 */
export interface StorageNodeOptions {
  storageDir: string;
  /** Path to encrypted keystore file for the node's Ed25519 identity */
  identityPath?: string;
  /** Password to decrypt the keystore at {@link identityPath} */
  identityPassword?: string;
  /** In-memory identity (alternative to keystore path) */
  identity?: Identity;
  /** If true, every piece operation requires a valid signature */
  requireAuth?: boolean;
  /** Max clock skew for timestamp validation (ms) */
  maxClockSkewMs?: number;
  /** Maximum buffered bytes for any storage-node HTTP request body. */
  maxHttpRequestBodyBytes?: number;
  /** Maximum remembered authenticated request nonces. */
  maxReplayCacheEntries?: number;
  metrics?: MetricsRegistry;
  events?: EventStore;
  /** Optional in-memory registry for node discovery */
  registry?: Registry;
  /** Heartbeat interval for registry (ms). Defaults to 10s or 1/3 of registry timeout */
  registryHeartbeatIntervalMs?: number;
  /** Total allocated bytes for this node (capacity). Defaults to 1 GiB */
  capacityBytes?: number;
  onLifecycleEvent?: (event: StorageNodeLifecycleEvent) => void;
  orphanCleanup?: { enabled?: boolean; gracePeriodMs?: number; intervalMs?: number; batchSize?: number; maxDeletionsPerRun?: number };
}
export type StorageNodeLifecycleEvent = { type: "storage-node.started" | "storage-node.closed" | "storage-node.draining" | "storage-node.recovery"; draining?: boolean; error?: string };
export interface StorageNodeStatusSnapshot {
  status: "ok" | "degraded" | "draining";
  draining: boolean;
  capacity: NodeCapacity;
  pieceCount: number;
  diagnostics?: { metrics: ReturnType<MetricsRegistry["snapshot"]>; events: ReturnType<EventStore["recent"]> };
}

export interface NodeCapacity {
  allocatedBytes?: number;
  usedBytes: number;
  availableBytes: number;
  /** @deprecated use allocatedBytes */
  totalBytes?: number;
}

/**
 * A running-capable storage node. Call {@link StorageNode.listen} to
 * bind (creating the storage directory) and {@link StorageNode.close}
 * to shut down.
 */
export interface StorageNode {
  readonly version: number;
  readonly storageDir: string;
  readonly server: Server;
  /** Node's Ed25519 identity if configured (private key stays server-side) */
  readonly identity?: Identity;
  /** Total capacity limit in bytes */
  readonly capacityBytes: number;
  /** Get current capacity/health info */
  getCapacity(): Promise<NodeCapacity>;
  getStatusSnapshot(): Promise<StorageNodeStatusSnapshot>;
  statusSnapshot(): Promise<StorageNodeStatusSnapshot>;
  /**
   * Resize the allocation quota (OPENSTORE-029). Pieces already stored
   * are untouched; shrinking below current usage is rejected so stored
   * data is never stranded over quota.
   */
  setCapacityBytes(capacityBytes: number): void;
  /** Whether the node is draining (read-only decommissioning). */
  isDraining(): boolean;
  /**
   * Enter/leave draining mode (OPENSTORE-029): draining nodes reject
   * new piece stores (503) while continuing to serve existing pieces,
   * so placement routes around them without stranding reads.
   */
  setDraining(draining: boolean): void;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Check whether a piece ID is safe to use as a file name.
 * Only ASCII letters, digits, `-`, and `_` (up to 128 chars) are
 * accepted, so IDs can never contain path separators or `..`.
 *
 * @param id Candidate piece ID.
 * @returns True when the ID may address a stored piece.
 */
export function isValidPieceId(id: string): boolean {
  return (
    typeof id === "string" &&
    id.length >= 1 &&
    id.length <= MAX_PIECE_ID_LENGTH &&
    PIECE_ID_PATTERN.test(id)
  );
}

/**
 * Create a storage node bound to a local directory (not yet listening).
 *
 * @param options Node options; `storageDir` holds one file per piece.
 * @returns Controllable node; call `listen()` to start accepting requests.
 * @throws If `storageDir` is not a non-empty string.
 */
export function createStorageNode(options: StorageNodeOptions): StorageNode {
  if (!options || typeof options.storageDir !== "string" || options.storageDir === "") {
    throw new TypeError("storageDir must be a non-empty string");
  }
  const storageDir = resolve(options.storageDir);
  const provenance = createPieceProvenanceStore(join(storageDir, ".provenance"), options.orphanCleanup?.gracePeriodMs);
  let orphanScanner: OrphanScanner | undefined;
  if (options.orphanCleanup?.enabled) {
    orphanScanner = createOrphanScanner({
      pieceDir: storageDir,
      provenance,
      intervalMs: options.orphanCleanup.intervalMs,
      batchSize: options.orphanCleanup.batchSize,
      maxDeletionsPerRun: options.orphanCleanup.maxDeletionsPerRun,
      events: options.events,
      deletePiece: async (pieceId) => {
        try { await unlink(join(storageDir, pieceId)); return "deleted"; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not-found"; throw error; }
      },
    });
  }
  const requireAuth = options.requireAuth ?? false;
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const maxHttpRequestBodyBytes = options.maxHttpRequestBodyBytes ?? DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES;
  const maxReplayCacheEntries = options.maxReplayCacheEntries ?? DEFAULT_MAX_REPLAY_CACHE_ENTRIES;
  const metrics = options.metrics ?? defaultMetrics;
  const events = options.events ?? defaultEvents;
  if (!Number.isSafeInteger(maxHttpRequestBodyBytes) || maxHttpRequestBodyBytes <= 0) {
    throw new TypeError("maxHttpRequestBodyBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxReplayCacheEntries) || maxReplayCacheEntries <= 0) {
    throw new TypeError("maxReplayCacheEntries must be a positive safe integer");
  }
  const seenNonces = new Map<string, number>();
  let capacityBytes = options.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
  if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) {
    throw new TypeError("capacityBytes must be a positive integer");
  }
  // Draining mode (OPENSTORE-029): when true the node serves reads but
  // rejects new stores so it can be decommissioned without data loss.
  let draining = false;
  const emit = (event: StorageNodeLifecycleEvent): void => {
    try {
      const error = event.error === undefined ? undefined : safeErrorMessage(event.error);
      options.onLifecycleEvent?.({ ...event, ...(error ? { error } : {}) });
    } catch {}
    try {
      const type = event.type === "storage-node.started" ? "node.started" : event.type === "storage-node.closed" ? "node.closed" : event.type === "storage-node.draining" ? "node.draining" : "node.recovery";
      events.append({ version: 1, timestamp: Date.now(), component: "storage-node", type, severity: event.error ? "error" : "info", details: event.error ? { reason: "transient" } : {} });
    } catch {}
  };

  let nodeIdentity: Identity | undefined = options.identity;
  const hasKeystore = typeof options.identityPath === "string" && options.identityPath !== "";

  const server = createServer((req, res) => {
    const started = Date.now();
    const pathParts = (req.url ?? "").split("?")[0]?.split("/").filter(Boolean) ?? [];
    const rawOperation = pathParts[0] === "pieces" || pathParts[1] === "pieces"
      ? (req.method === "POST" ? "store" : req.method === "HEAD" ? "head" : req.method === "DELETE" ? "delete" : "get")
      : pathParts[0] === "verify" || pathParts[1] === "verify" ? "verify" : "request";
    const candidate = rawOperation;
    const operation = (["store", "get", "head", "delete", "verify"].includes(candidate) ? candidate : "request") as "store" | "get" | "head" | "delete" | "verify" | "request";
    metrics.increment("storage_requests_total", 1, { operation });
    const originalEnd = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => {
      const status = res.statusCode;
      const result = status >= 200 && status < 300 ? "success" : status === 413 ? "rejected" : "error";
      metrics.increment("storage_request_errors_total", result === "error" ? 1 : 0, { operation, result });
      if (result === "error" || result === "rejected") {
        try { events.append({ version: 1, timestamp: Date.now(), component: "storage-node", type: result === "rejected" ? "storage.request-rejected" : "storage.request-error", severity: result === "rejected" ? "warning" : "error", details: { operation, result } }); } catch {}
      }
      metrics.increment("storage_request_rejections_total", result === "rejected" ? 1 : 0, { operation, result: "rejected" });
      if (operation === "store" && result === "success") metrics.increment("storage_piece_stores_total", 1, { result: "success" });
      if (operation === "get" && result === "success") metrics.increment("storage_piece_gets_total", 1, { result: "success" });
      if (operation === "delete" && result === "success") metrics.increment("storage_piece_deletes_total", 1, { result: "success" });
      if (operation === "verify" && result === "success") metrics.increment("storage_piece_verifications_total", 1, { result: "success" });
      metrics.observe("storage_request_duration_ms", Date.now() - started, { operation });
      return originalEnd(...args);
    }) as typeof res.end;
    void handleRequest(req, res, storageDir, capacityBytes, provenance, { requireAuth, maxClockSkewMs, seenNonces, maxReplayCacheEntries, maxHttpRequestBodyBytes }, () => nodeIdentity, () => draining, getStatusSnapshot, metrics, events).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, error instanceof RequestBodyTooLargeError ? 413 : 500, {
          error: error instanceof RequestBodyTooLargeError ? "request body too large" : "internal error",
        });
      } else {
        res.end();
      }
    });
  });

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let registeredBaseUrl: string | undefined;
  let registeredNodeId: string | undefined;

  async function getUsedBytes(): Promise<number> {
    try {
      const entries = await readdir(storageDir);
      let total = 0;
      for (const e of entries) {
        try {
          const s = await stat(join(storageDir, e));
          if (s.isFile()) total += s.size;
        } catch {}
      }
      return total;
    } catch {
      return 0;
    }
  }

  async function getCapacity(): Promise<NodeCapacity> {
    const used = await getUsedBytes();
    const available = Math.max(0, capacityBytes - used);
    return { allocatedBytes: capacityBytes, totalBytes: capacityBytes, usedBytes: used, availableBytes: available };
  }
  async function getStatusSnapshot(): Promise<StorageNodeStatusSnapshot> {
    const capacity = await getCapacity();
    let pieceCount = 0;
    try { pieceCount = (await readdir(storageDir)).length; } catch {}
    metrics.set("storage_used_bytes", capacity.usedBytes);
    metrics.set("storage_capacity_bytes", capacity.allocatedBytes ?? capacity.totalBytes ?? 0);
    metrics.set("storage_piece_count", pieceCount);
    metrics.set("storage_available", draining ? 0 : 1);
    metrics.set("storage_draining", draining ? 1 : 0);
    return { status: draining ? "draining" : "ok", draining, capacity, pieceCount, diagnostics: { metrics: metrics.snapshot(), events: events.recent(100) } };
  }

  const node: StorageNode = {
    version: STORAGE_NODE_VERSION,
    storageDir,
    server,
    get capacityBytes(): number {
      return capacityBytes;
    },
    setCapacityBytes(next: number): void {
      if (!Number.isInteger(next) || next <= 0) {
        throw new TypeError("capacityBytes must be a positive integer");
      }
      capacityBytes = next;
    },
    isDraining(): boolean {
      return draining;
    },
    setDraining(next: boolean): void {
      draining = next === true;
      emit({ type: "storage-node.draining", draining });
    },
    get identity(): Identity | undefined {
      return nodeIdentity;
    },
    async getCapacity(): Promise<NodeCapacity> {
      return getCapacity();
    },
    async getStatusSnapshot(): Promise<StorageNodeStatusSnapshot> {
      return getStatusSnapshot();
    },
    async statusSnapshot(): Promise<StorageNodeStatusSnapshot> {
      return getStatusSnapshot();
    },
    async listen(port: number = 0, host: string = "127.0.0.1"): Promise<number> {
      if (
        host !== "127.0.0.1" &&
        host !== "localhost" &&
        host !== "::1" &&
        !requireAuth
      ) {
        throw new Error("storage node requires authentication on non-loopback hosts");
      }
      // Load persisted identity via encrypted keystore if configured
      if (hasKeystore) {
        if (typeof options.identityPassword !== "string" || options.identityPassword === "") {
          throw new TypeError("identityPassword must be a non-empty string when identityPath is set");
        }
        const { loadIdentity } = await import("../../packages/identity/keystore.js");
        nodeIdentity = await loadIdentity(options.identityPassword, options.identityPath as string);
      }
      await mkdir(storageDir, { recursive: true });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = server.address();
      let actualPort: number;
      if (address !== null && typeof address === "object") {
        actualPort = address.port;
      } else {
        throw new Error("failed to determine listening port");
      }
      emit({ type: "storage-node.started" });
      orphanScanner?.start();

      // Register with registry if configured
      if (options.registry && nodeIdentity) {
        const baseUrl = `http://${host}:${actualPort}`;
        registeredBaseUrl = baseUrl;
        registeredNodeId = nodeIdentity.publicKey.toString("base64");
        try {
          const { createSignedRegistration } = await import("../../packages/registry/index.js");
          const cap = await getCapacity();
          const signed = createSignedRegistration(nodeIdentity, baseUrl, { capacity: cap });
          // Never send private key — only signed payload with publicKey
          options.registry.registerSigned(signed);
        } catch (err) {
          // Clean up server if registration fails
          try { events.append({ version: 1, timestamp: Date.now(), component: "storage-node", type: "node.registration-failed", severity: "error", details: { reason: "transient" } }); } catch {}
          await new Promise<void>((res) => server.close(() => res()));
          throw new Error(`registry registration failed: ${(err as Error).message}`);
        }
        // Start heartbeat
        const intervalMs = options.registryHeartbeatIntervalMs ?? 10_000;
        heartbeatTimer = setInterval(() => {
          if (!nodeIdentity || !registeredNodeId || !options.registry) return;
          void (async () => {
            try {
              const cap = await getCapacity();
              const { createSignedHeartbeat } = await import("../../packages/registry/index.js");
              const signed = createSignedHeartbeat(nodeIdentity as Identity, registeredNodeId as string, { capacity: cap });
              (options.registry as Registry).heartbeatSigned(signed);
            } catch {
              try { events.append({ version: 1, timestamp: Date.now(), component: "storage-node", type: "node.heartbeat-failed", severity: "warning", details: { reason: "transient" } }); } catch {}
            }
          })();
        }, intervalMs);
        // Don't keep process alive just for heartbeat
        if (heartbeatTimer && typeof (heartbeatTimer as unknown as { unref?: () => void }).unref === "function") {
          (heartbeatTimer as unknown as { unref: () => void }).unref();
        }
      }

      return actualPort;
    },
    async close(): Promise<void> {
      await orphanScanner?.stop();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      // Unregister from registry gracefully
      if (options.registry && registeredNodeId && nodeIdentity) {
        try {
          const { createSignedUnregister } = await import("../../packages/registry/index.js");
          const signed = createSignedUnregister(nodeIdentity, registeredNodeId);
          options.registry.unregisterSigned(signed);
        } catch {
          // Unregister failures on close should not hide close errors
        }
        registeredNodeId = undefined;
        registeredBaseUrl = undefined;
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) {
            rejectClose(err);
          } else {
            resolveClose();
          }
        });
        emit({ type: "storage-node.closed" });
      });
    },
  };
  return node;
}

interface AuthState {
  requireAuth: boolean;
  maxClockSkewMs: number;
  seenNonces: Map<string, number>;
  maxReplayCacheEntries: number;
  maxHttpRequestBodyBytes: number;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  storageDir: string,
  capacityBytes: number,
  provenance: PieceProvenanceStore,
  auth: AuthState,
  getNodeIdentity: () => Identity | undefined,
  isDraining: () => boolean,
  getStatusSnapshot: () => Promise<StorageNodeStatusSnapshot>,
  metrics: MetricsRegistry,
  events: EventStore,
): Promise<void> {
  const method = (req.method ?? "").toUpperCase();
  const rawPath = (req.url ?? "/").split("?")[0] as string;

  if (method === "GET" && (rawPath === "/health" || rawPath === "/status" || rawPath === "/v1/health" || rawPath === "/v1/status")) {
    if (auth.requireAuth && !checkAuth(req, method, rawPath, undefined, auth, res)) return;
    const snapshot = await getStatusSnapshot();
    sendJson(res, 200, snapshot);
    return;
  }

  if (rawPath.startsWith("/v2/pieces/")) {
    const body = method === "POST" ? await readBody(req, auth.maxHttpRequestBodyBytes) : undefined;
    if (!checkAuth(req, method, rawPath, body, auth, res)) return;
    await handleProvenanceRequest(req, res, rawPath, body, storageDir, capacityBytes, provenance);
    return;
  }

  if (method === "POST" && rawPath === "/pieces") {
    if (isDraining()) {
      // Decommissioning: reads stay available, new placements are refused
      // so replication routes around this node (callers tolerate it).
      req.resume();
      sendJson(res, 503, { error: "node is draining: not accepting new pieces" });
      return;
    }
    const rawBody = await readBody(req, auth.maxHttpRequestBodyBytes);
    if (!checkAuth(req, method, rawPath, rawBody, auth, res)) return;
    await handlePostPieceWithBody(rawBody, res, storageDir, capacityBytes);
    return;
  }

  const segments = rawPath.split("/");
  // Piece integrity verification (OPENSTORE-017): metadata only, never piece bytes.
  // Matches before the generic /pieces/:id route since it has an extra segment.
  if (segments.length === 4 && segments[1] === "pieces" && segments[3] === "verify") {
    const id = decodeSegment(segments[2] as string);
    if (id === null || !isValidPieceId(id)) {
      sendJson(res, 400, { error: "invalid piece id" });
      return;
    }
    if (!checkAuth(req, method, rawPath, undefined, auth, res)) return;
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    await handleVerifyPiece(res, join(storageDir, id), id, getNodeIdentity());
    return;
  }
  if (segments.length === 3 && segments[1] === "pieces") {
    const id = decodeSegment(segments[2] as string);
    if (id === null || !isValidPieceId(id)) {
      sendJson(res, 400, { error: "invalid piece id" });
      return;
    }
    if (!checkAuth(req, method, rawPath, undefined, auth, res)) return;
    const piecePath = join(storageDir, id);
    if (method === "GET") {
      await handleGetPiece(res, piecePath, false);
      return;
    }
    if (method === "HEAD") {
      await handleGetPiece(res, piecePath, true);
      return;
    }
    if (method === "DELETE") {
      await handleDeletePiece(res, piecePath);
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  // For unknown paths, still check auth if required
  if (auth.requireAuth) {
    if (!checkAuth(req, method, rawPath, undefined, auth, res)) return;
  } else {
    // If auth headers present on unknown path, still validate to avoid bypass
    const hasAuth = hasAuthHeaders(req.headers as Record<string, string | undefined>);
    if (hasAuth) {
      if (!checkAuth(req, method, rawPath, undefined, auth, res)) return;
    }
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleProvenanceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
  rawBody: Buffer | undefined,
  storageDir: string,
  capacityBytes: number,
  provenance: PieceProvenanceStore,
): Promise<void> {
  const segments = rawPath.split("/");
  const body = parseJsonObject(rawBody);
  const claimClientKey = String((req.headers as Record<string, string | undefined>)["x-openstore-pubkey"] ?? "");
  const claimClient = claimClientKey.length > 0 ? createHash("sha256").update(Buffer.from(claimClientKey, "base64")).digest("hex") : "";
  try {
    if (req.method === "POST" && rawPath === "/v2/pieces/claims") {
      const claim = body as unknown as PieceClaim;
      if (claim.clientNamespace !== claimClient) throw new Error("claim client namespace does not match authenticated identity");
      const created = await provenance.createClaim(claim);
      sendJson(res, 200, { status: "ok", claim: created });
      return;
    }
    if (segments.length === 5 && segments[1] === "v2" && segments[2] === "pieces") {
      const pieceId = decodeSegment(segments[3] as string);
      const operation = segments[4];
      if (!pieceId || !isValidPieceId(pieceId)) {
        sendJson(res, 400, { error: "invalid piece id" });
        return;
      }
      if (req.method === "POST" && operation === "store") {
        if (typeof body.claimId !== "string" || typeof body.data !== "string" || !isBase64(body.data)) throw new Error("invalid store claim body");
        await provenance.associatePiece(pieceId, body.claimId, async () => {
          const bytes = Buffer.from(body.data as string, "base64");
          if (hashPieceId(bytes) !== pieceId) throw new Error("piece bytes do not match piece id");
          await storePieceBytes(storageDir, capacityBytes, pieceId, bytes);
        });
        sendJson(res, 200, { status: "stored", pieceId });
        return;
      }
      if (req.method === "POST" && operation === "reference") {
        const claim = await provenance.markReferenced(pieceId, String(body.claimId ?? ""));
        sendJson(res, 200, { status: "referenced", claim });
        return;
      }
      if (req.method === "POST" && operation === "release") {
        const claim = await provenance.releaseClaim(pieceId, String(body.claimId ?? ""), claimClient);
        sendJson(res, 200, { status: "released", claim });
        return;
      }
      if (req.method === "POST" && operation === "reconcile") {
        const claim = await provenance.reconcile(pieceId, String(body.claimId ?? ""));
        sendJson(res, 200, { status: claim ? "known" : "unknown", ...(claim ? { claim } : {}) });
        return;
      }
    }
    if (req.method === "DELETE" && segments.length === 4 && segments[1] === "v2" && segments[2] === "pieces") {
      const pieceId = decodeSegment(segments[3] as string);
      if (!pieceId || !isValidPieceId(pieceId)) {
        sendJson(res, 400, { error: "invalid piece id" });
        return;
      }
      const result = await provenance.deleteIfUnclaimed(pieceId, async () => {
        try {
          await unlink(join(storageDir, pieceId));
          return "deleted";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not-found";
          throw error;
        }
      });
      sendJson(res, result.status === "deleted" ? 204 : result.status === "still-claimed" ? 409 : result.status === "not-found" ? 404 : 503, result.status === "still-claimed" ? { status: result.status, claims: result.claims.map(safeClaim) } : { status: result.status });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 409, { error: safeProvenanceError(error) });
  }
}

function parseJsonObject(rawBody: Buffer | undefined): Record<string, unknown> {
  if (!rawBody) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { throw new Error("invalid JSON body"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
  return parsed as Record<string, unknown>;
}

async function storePieceBytes(storageDir: string, capacityBytes: number, id: string, bytes: Buffer): Promise<void> {
  const piecePath = join(storageDir, id);
  let previous = 0;
  try { previous = (await stat(piecePath)).size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const used = await getUsedBytesForDir(storageDir);
  if (used - previous + bytes.length > capacityBytes) throw new Error("insufficient storage");
  await mkdir(storageDir, { recursive: true });
  await writeFile(piecePath, bytes, { mode: 0o600 });
}

function safeClaim(claim: PieceClaim): Omit<PieceClaim, "clientNamespace"> & { clientNamespace: string } {
  return { ...claim, clientNamespace: "[opaque]" };
}

function safeProvenanceError(error: unknown): string {
  return safeErrorMessage(error);
}

function hasAuthHeaders(headers: Record<string, string | undefined>): boolean {
  return (
    headers[PUBKEY_HEADER] !== undefined ||
    headers["x-openstore-timestamp"] !== undefined ||
    headers["x-openstore-nonce"] !== undefined ||
    headers["x-openstore-signature"] !== undefined
  );
}

function checkAuth(
  req: IncomingMessage,
  method: string,
  path: string,
  body: Buffer | undefined,
  auth: AuthState,
  res: ServerResponse,
): boolean {
  const headers = req.headers as Record<string, string | undefined>;
  const hasAuth = hasAuthHeaders(headers);
  if (!hasAuth) {
    if (auth.requireAuth) {
      sendJson(res, 401, { error: "missing authentication" });
      return false;
    }
    return true;
  }
  const result = verifyAuthHeaders(headers, method, path, body, auth.maxClockSkewMs, auth.seenNonces, auth.maxReplayCacheEntries);
  if (!result.valid) {
    // Map replay/expired/malformed to 401, with error message
    const msg = result.error ?? "invalid signature";
    const status = 401;
    // Use specific messages for testability
    if (msg === "replayed nonce") {
      sendJson(res, status, { error: "replayed request" });
    } else if (msg === "expired timestamp") {
      sendJson(res, status, { error: "expired timestamp" });
    } else if (msg === "invalid signature") {
      sendJson(res, status, { error: "invalid signature" });
    } else {
      sendJson(res, status, { error: msg });
    }
    return false;
  }
  return true;
}

async function handlePostPiece(
  req: IncomingMessage,
  res: ServerResponse,
  storageDir: string,
  capacityBytes: number = DEFAULT_CAPACITY_BYTES,
): Promise<void> {
  const raw = await readBody(req, DEFAULT_MAX_HTTP_REQUEST_BODY_BYTES);
  await handlePostPieceWithBody(raw, res, storageDir, capacityBytes);
}

/**
 * POST /pieces stores a piece.
 * JSON body: `{ "id": "<piece-id>", "data": "<base64 bytes>" }`.
 * Bodies carrying `key`/`encryptionKey` fields are rejected: the node
 * never accepts encryption keys.
 */
async function handlePostPieceWithBody(
  raw: Buffer,
  res: ServerResponse,
  storageDir: string,
  capacityBytes: number = DEFAULT_CAPACITY_BYTES,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return;
  }
  const body = parsed as Record<string, unknown>;
  if ("key" in body || "encryptionKey" in body) {
    sendJson(res, 400, { error: "storage node never accepts encryption keys" });
    return;
  }
  if (typeof body["id"] !== "string" || !isValidPieceId(body["id"])) {
    sendJson(res, 400, { error: "invalid piece id" });
    return;
  }
  if (typeof body["data"] !== "string" || !isBase64(body["data"])) {
    sendJson(res, 400, { error: "data must be a base64 string" });
    return;
  }

  const id = body["id"];
  const bytes = Buffer.from(body["data"], "base64");
  const piecePath = join(storageDir, id);

  let existed = false;
  let existingSize = 0;
  try {
    const st = await stat(piecePath);
    existed = true;
    existingSize = st.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  // Enforce capacity: only counts OpenStore storage directory (allocated quota, not physical disk)
  const used = await getUsedBytesForDir(storageDir);
  const projected = existed ? used - existingSize + bytes.length : used + bytes.length;
  if (projected > capacityBytes) {
    sendJson(res, 507, {
      error: "insufficient storage",
      capacity: { allocatedBytes: capacityBytes, totalBytes: capacityBytes, usedBytes: used, availableBytes: Math.max(0, capacityBytes - used) },
    });
    return;
  }

  await mkdir(storageDir, { recursive: true });
  await writeFile(piecePath, bytes);
  sendJson(res, existed ? 200 : 201, {
    version: STORAGE_NODE_VERSION,
    id,
    size: bytes.length,
  });
}

async function handleGetPiece(
  res: ServerResponse,
  piecePath: string,
  headOnly: boolean,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(piecePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 404, { error: "piece not found" });
      return;
    }
    throw err;
  }
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": bytes.length,
  });
  res.end(headOnly ? undefined : bytes);
}

/**
 * GET /pieces/:id/verify checks integrity without returning piece data.
 * Confirms the piece exists, its bytes hash to the expected pieceId
 * (content addressing), and reports the node's authentic identity
 * (public key only — private keys never leave the node).
 * Returns metadata only: pieceId, size, hash, verification status.
 */
async function handleVerifyPiece(
  res: ServerResponse,
  piecePath: string,
  expectedPieceId: string,
  nodeIdentity: Identity | undefined,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(piecePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 404, { error: "piece not found", pieceId: expectedPieceId, verified: false });
      return;
    }
    throw err;
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  const identityFields = nodeIdentity
    ? {
        nodeId: nodeIdentity.publicKey.toString("base64"),
        publicKey: nodeIdentity.publicKey.toString("base64"),
      }
    : {};
  if (actualHash !== expectedPieceId) {
    sendJson(res, 409, {
      version: STORAGE_NODE_VERSION,
      pieceId: expectedPieceId,
      size: bytes.length,
      hash: actualHash,
      expectedHash: expectedPieceId,
      verified: false,
      error: "hash mismatch: stored bytes do not match expected piece id",
      ...identityFields,
    });
    return;
  }
  sendJson(res, 200, {
    version: STORAGE_NODE_VERSION,
    pieceId: expectedPieceId,
    size: bytes.length,
    hash: actualHash,
    verified: true,
    ...identityFields,
  });
}

async function handleDeletePiece(
  res: ServerResponse,
  piecePath: string,
): Promise<void> {
  try {
    await unlink(piecePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 404, { error: "piece not found" });
      return;
    }
    throw err;
  }
  res.writeHead(204);
  res.end();
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

async function getUsedBytesForDir(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    let total = 0;
    for (const e of entries) {
      try {
        const s = await stat(join(dir, e));
        if (s.isFile()) total += s.size;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const declaredLength = req.headers["content-length"];
    if (declaredLength !== undefined) {
      const length = Number(declaredLength);
      if (Number.isSafeInteger(length) && length > maxBytes) {
        req.resume();
        rejectBody(new RequestBodyTooLargeError());
        return;
      }
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        req.resume();
        rejectBody(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}
