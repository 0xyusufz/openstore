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

import { createServer } from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { DEFAULT_MAX_CLOCK_SKEW_MS, PUBKEY_HEADER, verifyAuthHeaders } from "../../packages/auth/index.js";
import type { Identity } from "../../packages/identity/index.js";
import type { Registry } from "../../packages/registry/index.js";

export const STORAGE_NODE_VERSION = 1;

const MAX_PIECE_ID_LENGTH = 128;
const PIECE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_CAPACITY_BYTES = 1 * 1024 * 1024 * 1024;

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
  /** Optional in-memory registry for node discovery */
  registry?: Registry;
  /** Heartbeat interval for registry (ms). Defaults to 10s or 1/3 of registry timeout */
  registryHeartbeatIntervalMs?: number;
  /** Total allocated bytes for this node (capacity). Defaults to 1 GiB */
  capacityBytes?: number;
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
  const requireAuth = options.requireAuth ?? false;
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const seenNonces = new Map<string, number>();
  const capacityBytes = options.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
  if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) {
    throw new TypeError("capacityBytes must be a positive integer");
  }

  let nodeIdentity: Identity | undefined = options.identity;
  const hasKeystore = typeof options.identityPath === "string" && options.identityPath !== "";

  const server = createServer((req, res) => {
    void handleRequest(req, res, storageDir, capacityBytes, { requireAuth, maxClockSkewMs, seenNonces }).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
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

  const node: StorageNode = {
    version: STORAGE_NODE_VERSION,
    storageDir,
    server,
    capacityBytes,
    get identity(): Identity | undefined {
      return nodeIdentity;
    },
    async getCapacity(): Promise<NodeCapacity> {
      return getCapacity();
    },
    async listen(port: number = 0, host: string = "127.0.0.1"): Promise<number> {
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
            } catch {}
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
      });
    },
  };
  return node;
}

interface AuthState {
  requireAuth: boolean;
  maxClockSkewMs: number;
  seenNonces: Map<string, number>;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  storageDir: string,
  capacityBytes: number,
  auth: AuthState,
): Promise<void> {
  const method = (req.method ?? "").toUpperCase();
  const rawPath = (req.url ?? "/").split("?")[0] as string;

  if (method === "POST" && rawPath === "/pieces") {
    const rawBody = await readBody(req);
    if (!checkAuth(req, method, rawPath, rawBody, auth, res)) return;
    await handlePostPieceWithBody(rawBody, res, storageDir, capacityBytes);
    return;
  }

  const segments = rawPath.split("/");
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
  const result = verifyAuthHeaders(headers, method, path, body, auth.maxClockSkewMs, auth.seenNonces);
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
  const raw = await readBody(req);
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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolveBody(Buffer.concat(chunks));
    });
    req.on("error", rejectBody);
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
