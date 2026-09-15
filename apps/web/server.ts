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
import { createWebBackend } from "./backend.js";
import type { WebBackend, WebBackendOptions } from "./backend.js";

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
  // Identity actions are POST-only.
  if (
    rawPath === "/api/identity/create" ||
    rawPath === "/api/identity/unlock" ||
    rawPath === "/api/identity/lock"
  ) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" }, headOnly);
      return;
    }
  } else if (method === "POST") {
    // No other POST routes exist (uploads/downloads land next milestone).
    sendJson(res, 405, { error: "method not allowed" }, headOnly);
    return;
  }
  if (rawPath === "/api/files") {
    const snapshot = await backend.getSnapshot();
    sendJson(res, 200, { files: snapshot.files, source: snapshot.filesSource }, headOnly);
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

/** Map identity errors to safe statuses. Messages never carry secrets. */
function identityErrorStatus(message: string): number {
  if (/already configured/i.test(message)) return 409;
  if (/not configured/i.test(message)) return 400;
  if (/non-empty password|must be a|invalid/i.test(message)) return 400;
  if (/malformed/i.test(message)) return 400;
  if (/failed to read keystore|ENOENT|no such file/i.test(message)) return 404;
  return 401;
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

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
