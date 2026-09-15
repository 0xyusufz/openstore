/**
 * OpenStore Web Server (OPENSTORE-023, backend wiring in OPENSTORE-024)
 *
 * Minimal static file server for the dashboard (Node.js stdlib only).
 * Serves the app shell, stylesheet, compiled frontend modules from
 * `dist/`, a JSON health endpoint, and the `/api/*` backend boundary
 * (safe metadata only — see backend.ts). Unknown extensionless routes
 * fall back to the shell for hash-based SPA navigation.
 */

import { createServer } from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createWebBackend, MAX_UPLOAD_BYTES, sanitizeUploadFilename } from "./backend.js";
import type { WebBackend, WebBackendOptions, DownloadFileResult, UploadFileResult } from "./backend.js";
import { isValidManifestFileId } from "../../packages/manifest/store.js";

export const WEB_SERVER_VERSION = 1;
export const DEFAULT_WEB_PORT = 4173;

const JS_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface WebServerOptions extends WebBackendOptions {
  /** Repo root (defaults to the checkout containing this file). */
  rootDir?: string;
}

export interface WebServer {
  readonly version: number;
  readonly server: Server;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/**
 * Locate the repo root from this file, whether running from source
 * (`apps/web/`, e.g. under vitest) or compiled output (`dist/apps/web/`).
 */
export function findRepoRoot(fromDir: string): string {
  let dir = resolve(fromDir);
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "apps", "web", "index.html"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate repo root for openstore web assets");
}

export function createWebServer(options: WebServerOptions = {}): WebServer {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const root = options.rootDir ?? findRepoRoot(here);
  const webDir = join(root, "apps", "web");
  const jsDir = join(root, "dist", "apps", "web", "src");
  const backend: WebBackend = createWebBackend(options);

  const server = createServer((req, res) => {
    void handleRequest(req, res, webDir, jsDir, backend).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    });
  });

  return {
    version: WEB_SERVER_VERSION,
    server,
    async listen(port: number = DEFAULT_WEB_PORT, host: string = "127.0.0.1"): Promise<number> {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = server.address();
      if (address !== null && typeof address === "object") return address.port;
      throw new Error("failed to determine listening port");
    },
    async close(): Promise<void> {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  webDir: string,
  jsDir: string,
  backend: WebBackend,
): Promise<void> {
  const method = (req.method ?? "").toUpperCase();
  const rawPath = (req.url ?? "/").split("?")[0] as string;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  const headOnly = method === "HEAD";

  if (rawPath === "/health" || rawPath === "/api/health") {
    sendJson(res, 200, backend.getHealth(), headOnly);
    return;
  }
  // Identity actions and file upload are POST-only.
  if (
    rawPath === "/api/identity/create" ||
    rawPath === "/api/identity/unlock" ||
    rawPath === "/api/identity/lock" ||
    rawPath === "/api/identity/recover" ||
    rawPath === "/api/files/upload"
  ) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" }, headOnly);
      return;
    }
  } else if (method === "POST") {
    // No other POST routes exist (downloads land next milestone).
    sendJson(res, 405, { error: "method not allowed" }, headOnly);
    return;
  }
  if (rawPath === "/api/files") {
    const snapshot = await backend.getSnapshot();
    sendJson(res, 200, { files: snapshot.files, source: snapshot.filesSource }, headOnly);
    return;
  }
  if (
    (method === "GET" || method === "HEAD") &&
    rawPath.startsWith("/api/files/") &&
    rawPath.endsWith("/download")
  ) {
    const fileId = rawPath.slice("/api/files/".length, -"/download".length);
    if (!isValidManifestFileId(fileId)) {
      sendJson(res, 400, { error: "invalid file id" }, headOnly);
      return;
    }
    try {
      const result: DownloadFileResult = await backend.downloadFile(fileId);
      const attachmentName = toSafeDownloadFilename(result.filename, fileId);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": result.data.length,
        "content-disposition": `attachment; filename="${attachmentName}"`,
        "cache-control": "no-store",
      });
      res.end(headOnly ? undefined : result.data);
    } catch (err) {
      const message = (err as Error).message;
      sendJson(res, downloadErrorStatus(message), { error: toSafeDownloadError(message) }, headOnly);
    }
    return;
  }
  if (rawPath === "/api/nodes") {
    const snapshot = await backend.getSnapshot();
    sendJson(res, 200, { nodes: snapshot.nodes, source: snapshot.nodesSource }, headOnly);
    return;
  }
  if (rawPath === "/api/identity") {
    const snapshot = await backend.getSnapshot();
    sendJson(res, 200, { identity: snapshot.identity }, headOnly);
    return;
  }
  if (rawPath === "/api/identity/create" && method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const password = (body.value as Record<string, unknown>)["password"];
    try {
      const created = await backend.createIdentity(password as string);
      sendJson(res, 200, { publicKey: created.publicKey, recoveryPhrase: created.recoveryPhrase });
    } catch (err) {
      sendJson(res, identityErrorStatus((err as Error).message), { error: (err as Error).message });
    }
    return;
  }
  if (rawPath === "/api/identity/unlock" && method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const password = (body.value as Record<string, unknown>)["password"];
    try {
      const unlocked = await backend.unlockIdentity(password as string);
      sendJson(res, 200, { unlocked: unlocked.unlocked, publicKey: unlocked.publicKey });
    } catch (err) {
      sendJson(res, identityErrorStatus((err as Error).message), { error: (err as Error).message });
    }
    return;
  }
  if (rawPath === "/api/identity/lock" && method === "POST") {
    backend.lockIdentity();
    sendJson(res, 200, { locked: true });
    return;
  }
  if (rawPath === "/api/identity/recover" && method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const fields = body.value as Record<string, unknown>;
    const phrase = fields["phrase"];
    const password = fields["password"];
    const confirmReplace = fields["confirmReplace"] === true;
    try {
      const recovered = await backend.recoverIdentity(phrase as string[], password as string, confirmReplace);
      sendJson(res, 200, { publicKey: recovered.publicKey });
    } catch (err) {
      sendJson(res, identityErrorStatus((err as Error).message), { error: (err as Error).message });
    }
    return;
  }
  if (rawPath === "/api/files/upload" && method === "POST") {
    const contentType = (req.headers["content-type"] ?? "") as string;
    if (!contentType.includes("multipart/form-data")) {
      sendJson(res, 400, { error: "content-type must be multipart/form-data" }, headOnly);
      return;
    }
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) {
      sendJson(res, 400, { error: "missing boundary in content-type" }, headOnly);
      return;
    }
    // Boundaries may be quoted per RFC 2046 (e.g. boundary="abc123").
    const boundary = (boundaryMatch[1] as string).replace(/^"|"$/g, "");
    if (boundary === "") {
      sendJson(res, 400, { error: "missing boundary in content-type" }, headOnly);
      return;
    }
    const parts = await readMultipartBody(req, res, boundary);
    if (!parts) return;
    if (parts.filename === null || parts.file === null) {
      sendJson(res, 400, { error: "missing file or filename in form data" }, headOnly);
      return;
    }
    if (parts.file.length === 0) {
      sendJson(res, 400, { error: "file is empty: empty files are rejected" }, headOnly);
      return;
    }
    if (parts.file.length > MAX_UPLOAD_BYTES) {
      sendJson(res, 413, { error: "file too large (100 MB limit)" }, headOnly);
      return;
    }
    try {
      const result: UploadFileResult = await backend.uploadFile(parts.filename, parts.file);
      sendJson(res, 200, {
        fileId: result.fileId,
        filename: result.filename,
        size: result.size,
        totalChunks: result.totalChunks,
      });
    } catch (err) {
      const message = (err as Error).message;
      sendJson(res, uploadErrorStatus(message), { error: toSafeUploadError(message) });
    }
    return;
  }
  if (rawPath.startsWith("/api/")) {
    sendJson(res, 404, { error: "not found" }, headOnly);
    return;
  }
  if (rawPath === "/" || rawPath === "/index.html") {
    await sendFile(res, join(webDir, "index.html"), "text/html; charset=utf-8", headOnly);
    return;
  }
  if (rawPath === "/styles.css") {
    await sendFile(res, join(webDir, "styles.css"), "text/css; charset=utf-8", headOnly);
    return;
  }
  if (rawPath.startsWith("/src/") && rawPath.endsWith(".js")) {
    const name = rawPath.slice("/src/".length, -".js".length);
    if (!JS_NAME_PATTERN.test(name)) {
      sendJson(res, 400, { error: "invalid asset name" }, headOnly);
      return;
    }
    await sendFile(res, join(jsDir, `${name}.js`), "text/javascript; charset=utf-8", headOnly);
    return;
  }
  // Hash-routed SPA fallback for extensionless paths; anything else 404s.
  if (!rawPath.split("/").pop()?.includes(".")) {
    await sendFile(res, join(webDir, "index.html"), "text/html; charset=utf-8", headOnly);
    return;
  }
  sendJson(res, 404, { error: "not found" }, headOnly);
}

async function sendFile(res: ServerResponse, path: string, contentType: string, headOnly: boolean): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 404, { error: "not found" }, headOnly);
      return;
    }
    throw err;
  }
  res.writeHead(200, { "content-type": contentType, "content-length": bytes.length });
  res.end(headOnly ? undefined : bytes);
}

/**
 * Map upload errors to safe statuses without changing the historically
 * documented backend failures: unconfigured storage and unavailable
 * nodes remain 500 so existing clients keep their behavior, while
 * caller-fixable input problems are 400/413.
 */
function uploadErrorStatus(message: string): number {
  if (/file too large/i.test(message)) return 413;
  if (/file is empty|invalid filename|filename must|invalid upload|data must be a Buffer/i.test(message)) return 400;
  return 500;
}

/**
 * Strip any secret-adjacent content from upload error messages before
 * they cross the API boundary. Upload failures legitimately mention
 * piece IDs (content hashes) and node IDs (public keys), but must never
 * carry key material, phrases, passwords, or plaintext.
 */
function toSafeUploadError(message: string): string {
  if (typeof message !== "string" || message === "") return "upload failed";
  if (/privatekey|recoveryphrase|mnemonic|encryptionkey|decryptionkey|password|plaintext|auth\s*tag|authTag|ciphertext/i.test(message)) {
    return "upload failed";
  }
  // Bound message length so oversized internals never leak wholesale.
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

/**
 * Map download errors to safe statuses: unknown IDs and files whose key
 * was never vaulted here are 404; everything else fails closed as 500.
 * Messages never carry secrets (see {@link toSafeDownloadError}).
 */
function downloadErrorStatus(message: string): number {
  if (/invalid file id/i.test(message)) return 400;
  if (/file not found|file key unavailable|dek store is malformed/i.test(message)) return 404;
  return 500;
}

/**
 * Sanitize download error messages. Piece IDs (hashes) and node IDs
 * (public keys) may pass through; key material, phrases, passwords,
 * and plaintext never do.
 */
function toSafeDownloadError(message: string): string {
  if (typeof message !== "string" || message === "") return "download failed";
  if (/privatekey|recoveryphrase|mnemonic|encryptionkey|decryptionkey|\bdek\b|password|plaintext|auth\s*tag|authTag|ciphertext/i.test(message)) {
    return "download failed";
  }
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

/**
 * Make a stored filename safe for a Content-Disposition header:
 * re-sanitize (defense in depth for pre-existing manifests), then strip
 * header-significant characters. Falls back to `<fileId>.bin` rather
 * than failing a recoverable download.
 */
function toSafeDownloadFilename(filename: string, fileId = "download"): string {
  let safe: string;
  try {
    safe = sanitizeUploadFilename(filename);
  } catch {
    safe = `${fileId}.bin`;
  }
  safe = safe.replace(/["\\\r\n]/g, "_");
  return safe === "" ? `${fileId}.bin` : safe;
}

/** Map identity errors to safe statuses. Messages never carry secrets. */
function identityErrorStatus(message: string): number {
  if (/already configured/i.test(message)) return 409;
  if (/keystore already exists/i.test(message)) return 409;
  if (/not configured/i.test(message)) return 400;
  if (/non-empty password|must be a|invalid/i.test(message)) return 400;
  if (/invalid recovery phrase/i.test(message)) return 400;
  if (/recovery phrase must have exactly/i.test(message)) return 400;
  if (/malformed/i.test(message)) return 400;
  if (/failed to read keystore|ENOENT|no such file/i.test(message)) return 404;
  return 401;
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

interface MultipartParts {
  filename: string | null;
  file: Buffer | null;
}

/**
 * Read and parse a multipart/form-data body into { filename, file }.
 * Extracts the first file part from the form data. Binary content is
 * returned as a Buffer. No plaintext or key material is persisted.
 */
async function readMultipartBody(
  req: IncomingMessage,
  res: ServerResponse,
  boundary: string,
): Promise<MultipartParts | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > MAX_UPLOAD_BYTES) {
        sendJson(res, 413, { error: "file too large (100 MB limit)" });
        req.resume();
        return null;
      }
      chunks.push(buf);
    }
  } catch {
    sendJson(res, 400, { error: "failed to read request body" });
    return null;
  }
  const body = Buffer.concat(chunks);
  const boundaryBuf = Buffer.from(`--${boundary}`, "utf8");
  const parts = splitMultipartParts(body, boundaryBuf);
  let filename: string | null = null;
  let file: Buffer | null = null;
  for (const part of parts) {
    const headerEnd = indexOf(part, Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headerSection = part.subarray(0, headerEnd).toString("utf8");
    const content = part.subarray(headerEnd + 4);
    const cdMatch = headerSection.match(/content-disposition: form-data;.*filename="([^"]*)"/i);
    if (cdMatch && file === null) {
      filename = decodeMultipartFilename(cdMatch[1] as string);
      file = content;
    }
  }
  return { filename, file };
}

function splitMultipartParts(body: Buffer, boundaryBuf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  // RFC 2046 delimiters are full lines: the boundary text is preceded by
  // CRLF except for the very first delimiter that opens the body.
  // Requiring that framing keeps arbitrary file bytes (which may contain
  // the boundary text mid-content) from splitting the body early — the
  // only residual collision is content holding CRLF + boundary verbatim,
  // infeasible with browser-generated random boundaries.
  const delimiterAt = (from: number): number => {
    let at = indexOf(body, boundaryBuf, from);
    while (at !== -1 && at !== 0 && !(body[at - 2] === 0x0d && body[at - 1] === 0x0a)) {
      at = indexOf(body, boundaryBuf, at + 1);
    }
    return at;
  };
  let start = delimiterAt(0);
  if (start === -1) return parts;
  start += boundaryBuf.length;
  while (start < body.length) {
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    const nextBoundary = delimiterAt(start);
    if (nextBoundary === -1) break;
    let partEnd = nextBoundary - 2;
    if (partEnd >= 0 && body[partEnd] === 0x0d) partEnd -= 1;
    if (partEnd >= start) parts.push(body.subarray(start, partEnd + 1));
    start = nextBoundary + boundaryBuf.length;
  }
  return parts;
}

/**
 * Binary-safe subsequence search using the native Buffer implementation
 * (O(n) memchr-style scan instead of a JS-level O(n*m) loop, which
 * matters for multi-megabyte uploads). Returns -1 when absent.
 */
function indexOf(haystack: Buffer, needle: Buffer, fromIndex = 0): number {
  return haystack.indexOf(needle, fromIndex);
}

/**
 * Take a multipart filename verbatim: browsers transmit it raw, so
 * URL-decoding would corrupt legitimate names (`a+b.txt` → `a b.txt`).
 * Only strip CR/LF to block header injection; deeper sanitization
 * (traversal, controls, length) happens in the backend boundary.
 */
function decodeMultipartFilename(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > MAX_JSON_BODY_BYTES) {
        sendJson(res, 413, { error: "request body too large" });
        // Drain to free the socket (best effort).
        req.resume();
        return { ok: false };
      }
      chunks.push(buf);
    }
  } catch {
    sendJson(res, 400, { error: "failed to read request body" });
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    sendJson(res, 400, { error: "body must be a JSON object" });
    return { ok: false };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(headOnly ? undefined : text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portArg = Number(process.env["OPENSTORE_WEB_PORT"] ?? process.argv[2] ?? DEFAULT_WEB_PORT);
  const port = Number.isInteger(portArg) && portArg > 0 ? portArg : DEFAULT_WEB_PORT;
  // Optional live backend: point at a ManifestStore directory to serve the
  // real file catalog instead of demo data, and at a keystore file to
  // enable local identity management. Unset → explicit demo fallback.
  const manifestDir = process.env["OPENSTORE_WEB_MANIFEST_DIR"] || undefined;
  const keystorePath = process.env["OPENSTORE_WEB_KEYSTORE"] || undefined;
  const web = createWebServer({ ...(manifestDir ? { manifestDir } : {}), ...(keystorePath ? { keystorePath } : {}) });
  web
    .listen(port, "127.0.0.1")
    .then((actual) => {
      console.log(`OpenStore web dashboard at http://127.0.0.1:${actual}/`);
    })
    .catch((err) => {
      console.error(`Failed to start web server: ${(err as Error).message}`);
      process.exitCode = 1;
    });
}
