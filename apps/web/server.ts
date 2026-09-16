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
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        throw new Error("web server must bind to loopback");
      }
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
  // Identity actions, provider actions, and file upload are POST-only.
  if (
    rawPath === "/api/identity/create" ||
    rawPath === "/api/identity/unlock" ||
    rawPath === "/api/identity/lock" ||
    rawPath === "/api/identity/recover" ||
    rawPath === "/api/provider/setup" ||
    rawPath === "/api/provider/start" ||
    rawPath === "/api/provider/stop" ||
    rawPath === "/api/provider/release" ||
    rawPath === "/api/provider/allocation" ||
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
  if (rawPath === "/api/provider") {
    const snapshot = await backend.getSnapshot();
    sendJson(res, 200, { provider: snapshot.provider ?? null }, headOnly);
    return;
  }
  if (rawPath === "/api/provider/setup" && method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const fields = body.value as Record<string, unknown>;
    try {
      const status = await backend.provider.setup(fields["location"], fields["capacityBytes"], fields["port"]);
      sendJson(res, 200, { provider: status });
    } catch (err) {
      sendJson(res, providerErrorStatus((err as Error).message), { error: toSafeProviderError((err as Error).message) });
    }
    return;
  }
  if (rawPath === "/api/provider/start" && method === "POST") {
    try {
      const status = await backend.provider.start();
      sendJson(res, 200, { provider: status });
    } catch (err) {
      sendJson(res, providerErrorStatus((err as Error).message), { error: toSafeProviderError((err as Error).message) });
    }
    return;
  }
  if (rawPath === "/api/provider/stop" && method === "POST") {
    try {
      const status = await backend.provider.stop();
      sendJson(res, 200, { provider: status });
    } catch (err) {
      sendJson(res, providerErrorStatus((err as Error).message), { error: toSafeProviderError((err as Error).message) });
    }
    return;
  }
  if (rawPath === "/api/provider/release" && method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const fields = body.value as Record<string, unknown>;
    try {
      const result = await backend.provider.release(fields["confirm"]);
      sendJson(res, 200, { released: result.released, storageDir: result.storageDir });
    } catch (err) {
      sendJson(res, providerErrorStatus((err as Error).message), { error: toSafeProviderError((err as Error).message) });
    }
    return;
  }
  if (rawPath === "/api/provider/allocation" && method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body.ok) return;
    const fields = body.value as Record<string, unknown>;
    try {
      const status = await backend.provider.setAllocation(fields["capacityBytes"]);
      sendJson(res, 200, { provider: status });
    } catch (err) {
      sendJson(res, providerErrorStatus((err as Error).message), { error: toSafeProviderError((err as Error).message) });
    }
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
      sendJson(res, identityErrorStatus((err as Error).message), { error: toSafeIdentityError((err as Error).message) });
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
      sendJson(res, identityErrorStatus((err as Error).message), { error: toSafeIdentityError((err as Error).message) });
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
      sendJson(res, identityErrorStatus((err as Error).message), { error: toSafeIdentityError((err as Error).message) });
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
 * carry key material, phrases, passwords, plaintext, filesystem paths,
 * or stack traces. Where possible, map to actionable messages.
 */
function toSafeUploadError(message: string): string {
  if (typeof message !== "string" || message === "") return "Upload failed. Please try again.";
  if (/privatekey|recoveryphrase|mnemonic|encryptionkey|decryptionkey|password|plaintext|auth\s*tag|authTag|ciphertext/i.test(message)) {
    return "Upload failed. Please try again.";
  }
  if (/\/[^\s]*\.(?:json|txt|log|db)|ENOENT|EACCES|statfs|\bat .*:\d+:\d+|\bstack\b/i.test(message)) {
    return "Storage error. Please try again.";
  }
  let safe = message;
  if (/no storage nodes available/i.test(safe)) return "No storage nodes are available. Try again when a node is online.";
  if (/insufficient storage|quota/i.test(safe)) return "Storage is full. Free up space or increase your allocation.";
  if (/file is empty/i.test(safe)) return "File is empty and cannot be uploaded.";
  if (/file too large/i.test(safe)) return "File is too large (100 MB limit).";
  if (/invalid filename/i.test(safe)) return "Filename is not valid.";
  if (/draining/i.test(safe)) return "A storage node is draining and not accepting new data. Try again shortly.";
  // Bound message length so oversized internals never leak wholesale.
  safe = safe.replace(/\s+/g, " ").trim();
  return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
}

/**
 * Map provider errors to safe statuses. Messages never carry secrets
 * (see {@link toSafeProviderError}).
 */
function providerErrorStatus(message: string): number {
  if (/already configured|pieces .*remain/i.test(message)) return 409;
  if (/not configured/i.test(message)) return 404;
  if (/must be|invalid|requir|empty|not a directory|exceeds free|confirm|below current usage/i.test(message)) return 400;
  return 500;
}

function toSafeIdentityError(message: string): string {
  if (typeof message !== "string" || message === "") return "Identity request failed. Please try again.";
  if (/privatekey|recoveryphrase|mnemonic|password|secret|keystore|invalid word|checksum|corrupt|tamper|decrypt/i.test(message)) {
    return "Identity request failed. Please verify the supplied values and try again.";
  }
  return "Identity request failed. Please try again.";
}

/**
 * Sanitize provider error messages. Counts and plain-English reasons
 * pass through; key material, phrases, passwords, piece bytes, paths
 * and stacks never do.
 */
function toSafeProviderError(message: string): string {
  if (typeof message !== "string" || message === "") return "Provider request failed. Please try again.";
  if (/privatekey|recoveryphrase|mnemonic|encryptionkey|decryptionkey|\bdek\b|password|plaintext|auth\s*tag|authTag|ciphertext/i.test(message)) {
    return "Provider request failed. Please try again.";
  }
  if (/\/[^\s]*\.(?:json|txt|log|db)|ENOENT|EACCES|statfs|\bat .*:\d+:\d+/i.test(message)) {
    return "Storage error. Please try again.";
  }
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
 * plaintext, paths and stacks never do.
 */
function toSafeDownloadError(message: string): string {
  if (typeof message !== "string" || message === "") return "Download failed. Please try again.";
  if (/privatekey|recoveryphrase|mnemonic|encryptionkey|decryptionkey|\bdek\b|password|plaintext|auth\s*tag|authTag|ciphertext/i.test(message)) {
    return "Download failed. Please try again.";
  }
  if (/\/[^\s]*\.(?:json|txt|log|db)|ENOENT|EACCES|statfs|\bat .*:\d+:\d+/i.test(message)) {
    return "Storage error. Please try again.";
  }
  let safe = message;
  if (/file not found|file key unavailable|not found/i.test(safe)) return "File not found or is unavailable.";
  if (/corrupt|hash mismatch|size mismatch|decryption failed|wrong key/i.test(safe)) return "File appears corrupted or the key is wrong. Download failed safely.";
  if (/piece.*unavailable/i.test(safe)) return "File pieces are temporarily unavailable. Try again shortly.";
  safe = safe.replace(/\s+/g, " ").trim();
  return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
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

/**
 * Parse a comma-separated env list into trimmed non-empty entries.
 * Unset/blank → []. Exported for unit tests.
 */
export function parseCsvList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Parse per-node ports for `parseCsvList`'d storage dirs. Unset → all
 * ephemeral (0). Set → must match the dir count, each 1–65535.
 * Exported for unit tests.
 */
export function parseStoragePorts(value: string | undefined, expectedCount: number): number[] {
  if (value === undefined || value.trim() === "") return new Array<number>(expectedCount).fill(0);
  const parts = parseCsvList(value);
  if (parts.length !== expectedCount) {
    throw new Error(
      `OPENSTORE_WEB_STORAGE_PORTS has ${parts.length} entries but OPENSTORE_WEB_STORAGE_DIRS has ${expectedCount}`,
    );
  }
  return parts.map((part) => {
    const port = Number(part);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid storage node port: "${part}" (must be 1–65535)`);
    }
    return port;
  });
}

/**
 * Whether the standalone server should back the backend with a real
 * (initially empty) registry: true when storage dirs are configured,
 * or when explicitly opted in via OPENSTORE_WEB_REGISTRY=1/true.
 * Exported for unit tests.
 */
export function shouldEnableRegistry(env: NodeJS.ProcessEnv, storageDirCount: number): boolean {
  if (storageDirCount > 0) return true;
  const flag = (env["OPENSTORE_WEB_REGISTRY"] ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * Parse the per-node capacity override (bytes). Unset → node default.
 * Exported for unit tests.
 */
export function parseStorageCapacityBytes(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const bytes = Number(value);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`invalid OPENSTORE_WEB_STORAGE_CAPACITY_BYTES: "${value}" (must be a positive integer)`);
  }
  return bytes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void (async () => {
    try {
      await runStandaloneServer(process.env, process.argv.slice(2));
    } catch (err) {
      console.error(`Failed to start web server: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  })();
}

/**
 * Standalone entrypoint: registry + real storage nodes + web dashboard
 * in one process for local development and integration testing.
 *
 * Environment:
 * - OPENSTORE_WEB_PORT / argv[0]: dashboard port (default 4173).
 * - OPENSTORE_WEB_MANIFEST_DIR: live file catalog (unset → demo files).
 * - OPENSTORE_WEB_KEYSTORE: local identity management (unset → demo identity).
 * - OPENSTORE_WEB_STORAGE_DIRS: comma-separated storage dirs, one real
 *   storage node per dir sharing the web backend's registry with signed
 *   registration + heartbeat (unset → demo nodes).
 * - OPENSTORE_WEB_REGISTRY=1/true: back the backend with a real (empty)
 *   registry without preconfigured nodes, for provider-only setups.
 * - OPENSTORE_WEB_STORAGE_PORTS: optional per-node ports matching DIRS
 *   (unset → ephemeral ports, actual URLs are logged).
 * - OPENSTORE_WEB_STORAGE_CAPACITY_BYTES: optional per-node quota.
 */
export async function runStandaloneServer(env: NodeJS.ProcessEnv, args: string[]): Promise<void> {
  const portArg = Number(env["OPENSTORE_WEB_PORT"] ?? args[0] ?? DEFAULT_WEB_PORT);
  const port = Number.isInteger(portArg) && portArg > 0 ? portArg : DEFAULT_WEB_PORT;
  const manifestDir = env["OPENSTORE_WEB_MANIFEST_DIR"] || undefined;
  const keystorePath = env["OPENSTORE_WEB_KEYSTORE"] || undefined;

  const storageDirs = parseCsvList(env["OPENSTORE_WEB_STORAGE_DIRS"]);
  const storagePorts = parseStoragePorts(env["OPENSTORE_WEB_STORAGE_PORTS"], storageDirs.length);
  const capacityBytes = parseStorageCapacityBytes(env["OPENSTORE_WEB_STORAGE_CAPACITY_BYTES"]);

  // Dynamically imported so library consumers never pay for the
  // storage-node graph unless they run the standalone server.
  const { createRegistry } = await import("../../packages/registry/index.js");
  const { createIdentity } = await import("../../packages/identity/index.js");
  const { createStorageNode } = await import("../storage-node/index.js");
  type StorageNode = import("../storage-node/index.js").StorageNode;

  const nodes: StorageNode[] = [];
  // Hand the backend a real registry when nodes back it, or when live
  // mode is explicitly opted in. Otherwise the UI honestly stays on
  // demo data instead of a hollow Live state.
  const registry = shouldEnableRegistry(env, storageDirs.length) ? createRegistry() : undefined;
  try {
    for (let i = 0; i < storageDirs.length; i += 1) {
      const node = createStorageNode({
        storageDir: storageDirs[i] as string,
        identity: createIdentity(),
        ...(registry ? { registry } : {}),
        registryHeartbeatIntervalMs: 5000,
        ...(capacityBytes !== undefined ? { capacityBytes } : {}),
      });
      const actualPort = await node.listen(storagePorts[i] as number, "127.0.0.1");
      nodes.push(node);
      console.log(`OpenStore storage node at http://127.0.0.1:${actualPort}/ (${storageDirs[i]})`);
    }
    const web = createWebServer({
      ...(manifestDir ? { manifestDir } : {}),
      ...(keystorePath ? { keystorePath } : {}),
      ...(registry ? { registry } : {}),
    });
    const actual = await web.listen(port, "127.0.0.1");
    console.log(`OpenStore web dashboard at http://127.0.0.1:${actual}/`);
    if (storageDirs.length === 0 && !registry) {
      console.log("No storage nodes configured (set OPENSTORE_WEB_STORAGE_DIRS) — showing demo nodes; uploads will fail.");
    }
    if (storageDirs.length === 0 && registry) {
      console.log("Live registry enabled with no storage nodes yet — share storage from the Storage Nodes page.");
    }
    const shutdown = () => {
      void (async () => {
        for (const node of nodes) {
          try { await node.close(); } catch {}
        }
        try { await web.close(); } catch {}
        process.exit(0);
      })();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (err) {
    for (const node of nodes) {
      try { await node.close(); } catch {}
    }
    throw err;
  }
}
