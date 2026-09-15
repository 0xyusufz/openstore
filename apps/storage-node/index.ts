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
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";

export const STORAGE_NODE_VERSION = 1;

const MAX_PIECE_ID_LENGTH = 128;
const PIECE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Options for {@link createStorageNode}.
 */
export interface StorageNodeOptions {
  storageDir: string;
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
  const server = createServer((req, res) => {
    void handleRequest(req, res, storageDir).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    });
  });

  return {
    version: STORAGE_NODE_VERSION,
    storageDir,
    server,
    async listen(port: number = 0, host: string = "127.0.0.1"): Promise<number> {
      await mkdir(storageDir, { recursive: true });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = server.address();
      if (address !== null && typeof address === "object") {
        return address.port;
      }
      throw new Error("failed to determine listening port");
    },
    async close(): Promise<void> {
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
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  storageDir: string,
): Promise<void> {
  const method = (req.method ?? "").toUpperCase();
  const rawPath = (req.url ?? "/").split("?")[0] as string;

  if (method === "POST" && rawPath === "/pieces") {
    await handlePostPiece(req, res, storageDir);
    return;
  }

  const segments = rawPath.split("/");
  if (segments.length === 3 && segments[1] === "pieces") {
    const id = decodeSegment(segments[2] as string);
    if (id === null || !isValidPieceId(id)) {
      sendJson(res, 400, { error: "invalid piece id" });
      return;
    }
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

  sendJson(res, 404, { error: "not found" });
}

/**
 * POST /pieces stores a piece.
 * JSON body: `{ "id": "<piece-id>", "data": "<base64 bytes>" }`.
 * Bodies carrying `key`/`encryptionKey` fields are rejected: the node
 * never accepts encryption keys.
 */
async function handlePostPiece(
  req: IncomingMessage,
  res: ServerResponse,
  storageDir: string,
): Promise<void> {
  const raw = await readBody(req);
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
  try {
    await stat(piecePath);
    existed = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
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
