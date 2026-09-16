/**
 * Cross-process registry protocol (Milestone 041).
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "http";
import { request as httpsRequest } from "https";
import type { Identity } from "../identity/index.js";
import type { NodeCapacity, P2PRegistrationDescriptor, Registry, SignedHeartbeat, SignedRegistration, SignedUnregister } from "./index.js";
import { createSignedHeartbeat, createSignedLibp2pHeartbeat, createSignedLibp2pRegistration, createSignedRegistration, createSignedUnregister } from "./index.js";

export const REGISTRY_PROTOCOL_VERSION = 1;
export const DEFAULT_REGISTRY_COORDINATOR_PORT = 4190;
export interface RegistryCoordinatorOptions { registry: Registry; token?: string; host?: string; maxBodyBytes?: number; }
export interface RegistryCoordinator { readonly server: Server; readonly address: string; listen(port?: number, host?: string): Promise<number>; close(): Promise<void>; }
export interface RegistryClientOptions { baseUrl: string; token?: string; }
export interface RegistryClient {
  register(signed: SignedRegistration): Promise<any>; heartbeat(signed: SignedHeartbeat): Promise<any>; unregister(signed: SignedUnregister): Promise<void>; nodes(): Promise<any[]>;
  registerWithIdentity(identity: Identity, baseUrl: string, capacity?: NodeCapacity): Promise<any>;
  heartbeatWithIdentity(identity: Identity, nodeId: string, capacity?: NodeCapacity): Promise<any>;
  unregisterWithIdentity(identity: Identity, nodeId: string): Promise<void>;
  registerLibp2pWithIdentity(identity: Identity, descriptor: P2PRegistrationDescriptor, capacity?: NodeCapacity): Promise<any>;
  heartbeatLibp2pWithIdentity(identity: Identity, descriptor: P2PRegistrationDescriptor, capacity?: NodeCapacity): Promise<any>;
}

export function createRegistryCoordinator(options: RegistryCoordinatorOptions): RegistryCoordinator {
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const server = createServer((req, res) => { void handle(req, res, options.registry, options.token, maxBody); });
  let port: number | undefined;
  let host = options.host ?? "127.0.0.1";
  return {
    server, get address() { return `http://${host}:${port ?? 0}`; },
    async listen(requestedPort = DEFAULT_REGISTRY_COORDINATOR_PORT, requestedHost = host) {
      if (requestedHost !== "127.0.0.1" && requestedHost !== "localhost" && requestedHost !== "::1") throw new Error("registry coordinator must bind to loopback");
      host = requestedHost;
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(requestedPort, host, () => { server.off("error", reject); resolve(); }); });
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("failed to determine coordinator port");
      port = addr.port; return port;
    },
    async close() { if (!server.listening) return; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const url = (path: string) => `${options.baseUrl.replace(/\/$/, "")}${path}`;
  const post = (path: string, body: unknown) => requestJson(url(path), "POST", body, options.token);
  return {
    async register(signed) { return (await post("/v1/register", signed)).node; },
    async heartbeat(signed) { return (await post("/v1/heartbeat", signed)).node; },
    async unregister(signed) { await post("/v1/unregister", signed); },
    async nodes() { return (await requestJson(url("/v1/nodes"), "GET", undefined, options.token)).nodes; },
    registerWithIdentity(identity, baseUrl, capacity) { return this.register(createSignedRegistration(identity, baseUrl, capacity ? { capacity } : {})); },
    heartbeatWithIdentity(identity, nodeId, capacity) { return this.heartbeat(createSignedHeartbeat(identity, nodeId, capacity ? { capacity } : {})); },
    unregisterWithIdentity(identity, nodeId) { return this.unregister(createSignedUnregister(identity, nodeId)); },
    registerLibp2pWithIdentity(identity, descriptor, capacity) { return this.register(createSignedLibp2pRegistration(identity, descriptor, capacity ? { capacity } : {})); },
    heartbeatLibp2pWithIdentity(identity, descriptor, capacity) { return this.heartbeat(createSignedLibp2pHeartbeat(identity, descriptor, capacity ? { capacity } : {})); },
  };
}

function requestJson(urlString: string, method: "GET" | "POST", body: unknown, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(urlString); } catch (error) { reject(error); return; }
    const request = parsed.protocol === "https:" ? httpsRequest : parsed.protocol === "http:" ? httpRequest : undefined;
    if (!request) { reject(new Error(`unsupported registry coordinator protocol: ${parsed.protocol}`)); return; }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: parsed.hostname, port: parsed.port || undefined, path: `${parsed.pathname}${parsed.search}`, method,
      headers: { accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) }), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
      let data = ""; response.setEncoding("utf8"); response.on("data", (chunk: string) => { data += chunk; });
      response.on("end", () => {
        let payload: any = {};
        if (data) { try { payload = JSON.parse(data); } catch { if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) return reject(new Error("registry coordinator returned invalid JSON")); } }
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) return reject(new Error(payload?.error ?? `registry coordinator returned ${status}`));
        resolve(payload);
      });
    });
    req.on("error", reject); if (serialized !== undefined) req.write(serialized); req.end();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, registry: Registry, token: string | undefined, maxBody: number): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  if (token && req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && (path === "/health" || path === "/v1/health")) return send(res, 200, { status: "ok", protocol: REGISTRY_PROTOCOL_VERSION });
  if (req.method === "GET" && (path === "/nodes" || path === "/v1/nodes")) return send(res, 200, { protocol: REGISTRY_PROTOCOL_VERSION, nodes: registry.list() });
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  try {
    const body = await readBody(req, maxBody);
    if (path === "/register" || path === "/v1/register") return send(res, 200, { node: registry.registerSigned(body as SignedRegistration) });
    if (path === "/heartbeat" || path === "/v1/heartbeat") return send(res, 200, { node: registry.heartbeatSigned(body as SignedHeartbeat) });
    if (path === "/unregister" || path === "/v1/unregister") { registry.unregisterSigned(body as SignedUnregister); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: "not found" });
  } catch (error) { return send(res, 400, { error: error instanceof Error ? error.message : "invalid request" }); }
}
function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => { let data = ""; let size = 0; req.setEncoding("utf8");
    req.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > max) { reject(new Error("request body too large")); req.destroy(); } else data += chunk; });
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid JSON")); } }); req.on("error", reject); });
}
function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" }); res.end(body);
}
