/**
 * OpenStore Web Server (OPENSTORE-023)
 *
 * Minimal static file server for the dashboard (Node.js stdlib only).
 * Serves the app shell, stylesheet, compiled frontend modules from
 * `dist/`, and a JSON health endpoint. Unknown extensionless routes
 * fall back to the shell for hash-based SPA navigation.
 */

import { createServer } from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

export const WEB_SERVER_VERSION = 1;
export const DEFAULT_WEB_PORT = 4173;

const JS_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface WebServerOptions {
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

  const server = createServer((req, res) => {
    void handleRequest(req, res, webDir, jsDir).catch(() => {
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
): Promise<void> {
  const method = (req.method ?? "").toUpperCase();
  const rawPath = (req.url ?? "/").split("?")[0] as string;
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  const headOnly = method === "HEAD";

  if (rawPath === "/health") {
    sendJson(res, 200, { status: "ok", app: "openstore-web", version: WEB_SERVER_VERSION }, headOnly);
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

function sendJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(headOnly ? undefined : text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portArg = Number(process.env["OPENSTORE_WEB_PORT"] ?? process.argv[2] ?? DEFAULT_WEB_PORT);
  const port = Number.isInteger(portArg) && portArg > 0 ? portArg : DEFAULT_WEB_PORT;
  const web = createWebServer();
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
