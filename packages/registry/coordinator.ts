/**
 * Cross-process registry protocol (Milestone 041).
 *
 * The coordinator is deliberately a small, loopback-first HTTP process. Node
 * processes send the signed registry envelopes produced by `createSigned*`;
 * the coordinator never receives private keys and the registry remains the
 * single authority for signature, replay, expiry, and removal checks.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type { Identity } from "../identity/index.js";
import type { NodeCapacity, P2PRegistrationDescriptor, Registry, SignedHeartbeat, SignedRegistration, SignedUnregister } from "./index.js";
import { createSignedHeartbeat, createSignedLibp2pHeartbeat, createSignedLibp2pRegistration, createSignedRegistration, createSignedUnregister } from "./index.js";

export const REGISTRY_PROTOCOL_VERSION = 1;
export const DEFAULT_REGISTRY_COORDINATOR_PORT = 4190;

export interface RegistryCoordinatorOptions {
  registry: Registry;
  token?: string;
  host?: string;
  maxBodyBytes?: number;
}

export interface RegistryCoordinator {
  readonly server: Server;
  readonly address: string;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

export interface RegistryClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export interface RegistryClient {
  register(signed: SignedRegistration): Promise<any>;
  heartbeat(signed: SignedHeartbeat): Promise<any>;
  unregister(signed: SignedUnregister): Promise<void>;
  nodes(): Promise<any[]>;
  registerWithIdentity(identity: Identity, baseUrl: string, capacity?: NodeCapacity): Promise<any>;
  heartbeatWithIdentity(identity: Identity, nodeId: string, capacity?: NodeCapacity): Promise<any>;
  unregisterWithIdentity(identity: Identity, nodeId: string): Promise<void>;
  registerLibp2pWithIdentity(identity: Identity, descriptor: P2PRegistrationDescriptor, capacity?: NodeCapacity): Promise<any>;
  heartbeatLibp2pWithIdentity(identity: Identity, descriptor: P2PRegistrationDescriptor, capacity?: NodeCapacity): Promise<any>;
}

export function createRegistryCoordinator(options: RegistryCoordinatorOptions): RegistryCoordinator {
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const server = createServer((req, res) => {
    void handle(req, res, options.registry, options.token, maxBody);
  });
  let port: number | undefined;
  let host = options.host ?? "127.0.0.1";
  return {
    server,
    get address() { return `http://${host}:${port ?? 0}`; },
    async listen(requestedPort = DEFAULT_REGISTRY_COORDINATOR_PORT, requestedHost = host) {
      if (requestedHost !== "127.0.0.1" && requestedHost !== "localhost" && requestedHost !== "::1") {
        throw new Error("registry coordinator must bind to loopback");
      }
      host = requestedHost;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(requestedPort, host, () => { server.off("error", reject); resolve(); });
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("failed to determine coordinator port");
      port = addr.port;
      return port;
    },
    async close() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = (path: string) => `${options.baseUrl.replace(/\/$/, "")}${path}`;
  async function post(path: string, body: unknown): Promise<any> {
    const response = await fetchImpl(url(path), {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as any;
    if (!response.ok) throw new Error(payload?.error ?? `registry coordinator returned ${response.status}`);
    return payload;
  }
  return {
    async register(signed: SignedRegistration) { return (await post("/v1/register", signed)).node; },
    async heartbeat(signed: SignedHeartbeat) { return (await post("/v1/heartbeat", signed)).node; },
    async unregister(signed: SignedUnregister) { await post("/v1/unregister", signed); },
    async nodes() {
      const response = await fetchImpl(url("/v1/nodes"), { headers: options.token ? { authorization: `Bearer ${options.token}` } : {} });
      const payload = await response.json() as any;
      if (!response.ok) throw new Error(payload?.error ?? `registry coordinator returned ${response.status}`);
      return payload.nodes;
    },
    registerWithIdentity(identity: Identity, baseUrl: string, capacity?: NodeCapacity) {
      return this.register(createSignedRegistration(identity, baseUrl, capacity ? { capacity } : {}));
    },
    heartbeatWithIdentity(identity: Identity, nodeId: string, capacity?: NodeCapacity) {
      return this.heartbeat(createSignedHeartbeat(identity, nodeId, capacity ? { capacity } : {}));
    },
    unregisterWithIdentity(identity: Identity, nodeId: string) {
      return this.unregister(createSignedUnregister(identity, nodeId));
    },
    registerLibp2pWithIdentity(identity: Identity, descriptor: P2PRegistrationDescriptor, capacity?: NodeCapacity) {
      return this.register(createSignedLibp2pRegistration(identity, descriptor, capacity ? { capacity } : {}));
    },
    heartbeatLibp2pWithIdentity(identity: Identity, descriptor: P2PRegistrationDescriptor, capacity?: NodeCapacity) {
      return this.heartbeat(createSignedLibp2pHeartbeat(identity, descriptor, capacity ? { capacity } : {}));
    },
  };
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
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : "invalid request" });
  }
}

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ""; let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > max) { reject(new Error("request body too large")); req.destroy(); } else data += chunk; });
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}
function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}
