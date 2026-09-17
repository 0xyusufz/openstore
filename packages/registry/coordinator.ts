/**
 * Cross-process registry protocol (Milestone 045).
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "http";
import { request as httpsRequest } from "https";
import type { Identity } from "../identity/index.js";
import type { NodeCapacity, P2PRegistrationDescriptor, Registry, SignedHeartbeat, SignedRegistration, SignedUnregister } from "./index.js";
import { createSignedHeartbeat, createSignedLibp2pHeartbeat, createSignedLibp2pRegistration, createSignedRegistration, createSignedUnregister } from "./index.js";

export const REGISTRY_PROTOCOL_VERSION = 1;
export const DEFAULT_REGISTRY_COORDINATOR_PORT = 4190;
export interface CoordinatorLogger { info?: (message: string, details?: Record<string, string | number | boolean>) => void; warn?: (message: string, details?: Record<string, string | number | boolean>) => void; error?: (message: string, details?: Record<string, string | number | boolean>) => void; }
export type CoordinatorEvent =
  | { type: "coordinator.started" | "coordinator.closed"; address?: string; startedAt?: number; uptimeMs?: number }
  | { type: "coordinator.request"; operation: string; outcome: "success" | "error" }
  | { type: "coordinator.expiry"; expired: number };
export interface RegistryCoordinatorOptions { registry: Registry; token?: string; host?: string; maxBodyBytes?: number; logger?: CoordinatorLogger; onEvent?: (event: CoordinatorEvent) => void; onLifecycleEvent?: (event: CoordinatorEvent) => void; }
export interface RegistryCoordinatorOptions { expiryIntervalMs?: number; startExpiryWorker?: boolean; }
export interface RegistryCoordinator { readonly server: Server; readonly address: string; listen(port?: number, host?: string): Promise<number>; close(): Promise<void>; startExpiryWorker(): void; stopExpiryWorker(): void; }
export interface RegistryClientOptions { baseUrl: string; token?: string; }
export type RegistryClientErrorClassification = "transient" | "auth" | "config" | "protocol" | "unknown";
export class RegistryClientError extends Error {
  readonly classification: RegistryClientErrorClassification; readonly operation: string; readonly statusCode?: number;
  constructor(operation: string, classification: RegistryClientErrorClassification, message: string, statusCode?: number) {
    super(`${operation} failed (${classification}): ${message}`); this.name = "RegistryClientError"; this.operation = operation; this.classification = classification; this.statusCode = statusCode;
  }
}
export interface RegistryClient {
  register(signed: SignedRegistration): Promise<any>; heartbeat(signed: SignedHeartbeat): Promise<any>; unregister(signed: SignedUnregister): Promise<void>; nodes(): Promise<any[]>; status(): Promise<any>;
  registerWithIdentity(identity: Identity, baseUrl: string, capacity?: NodeCapacity): Promise<any>;
  heartbeatWithIdentity(identity: Identity, nodeId: string, capacity?: NodeCapacity): Promise<any>;
  unregisterWithIdentity(identity: Identity, nodeId: string): Promise<void>;
  registerLibp2pWithIdentity(identity: Identity, descriptor: P2PRegistrationDescriptor, capacity?: NodeCapacity): Promise<any>;
  heartbeatLibp2pWithIdentity(identity: Identity, descriptor: P2PRegistrationDescriptor, capacity?: NodeCapacity): Promise<any>;
}

export function createRegistryCoordinator(options: RegistryCoordinatorOptions): RegistryCoordinator {
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const emit = (event: CoordinatorEvent): void => {
    try { options.onEvent?.(event); } catch {}
    try { if (options.onLifecycleEvent && options.onLifecycleEvent !== options.onEvent) options.onLifecycleEvent(event); } catch {}
    try { const level = event.type === "coordinator.request" && event.outcome === "error" ? "error" : "info"; options.logger?.[level]?.(event.type, event.type === "coordinator.request" ? { operation: event.operation, outcome: event.outcome } : event.type === "coordinator.expiry" ? { expired: event.expired } : event.address ? { address: event.address } : {}); } catch {}
  };
  const server = createServer((req, res) => { void handle(req, res, options.registry, options.token, maxBody, emit, () => coordinatorStatus()); });
  let port: number | undefined; let host = options.host ?? "127.0.0.1";
  let startedAt: number | undefined;
  let expiryTimer: ReturnType<typeof setInterval> | undefined;
  let expiryRunning = false;
  const startExpiryWorker = (): void => {
    if (expiryTimer) return;
    const interval = options.expiryIntervalMs ?? Math.max(25, Math.floor(options.registry.heartbeatTimeoutMs / 3));
    if (!Number.isSafeInteger(interval) || interval <= 0) throw new TypeError("expiryIntervalMs must be a positive safe integer");
    expiryTimer = setInterval(() => {
      if (expiryRunning) return;
      expiryRunning = true;
      try {
        const expired = options.registry.pruneExpired();
        if (expired.length > 0) emit({ type: "coordinator.expiry", expired: expired.length });
      } finally { expiryRunning = false; }
    }, interval);
    expiryTimer.unref?.();
  };
  const stopExpiryWorker = (): void => { if (expiryTimer) { clearInterval(expiryTimer); expiryTimer = undefined; } };
  const coordinatorStatus = () => ({
    lifecycle: server.listening ? "running" : "stopped",
    startedAt: server.listening ? startedAt : undefined,
    uptimeMs: server.listening && startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : 0,
    heartbeatTimeoutMs: options.registry.heartbeatTimeoutMs,
  });
  return {
    server, get address() { return `http://${host}:${port ?? 0}`; },
    async listen(requestedPort = DEFAULT_REGISTRY_COORDINATOR_PORT, requestedHost = host) {
      if (requestedHost !== "127.0.0.1" && requestedHost !== "localhost" && requestedHost !== "::1" && requestedHost !== "0.0.0.0") throw new Error("registry coordinator must bind to loopback or explicitly configured container address");
      host = requestedHost;
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(requestedPort, host, () => { server.off("error", reject); resolve(); }); });
      const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("failed to determine coordinator port");
      port = addr.port;
      startedAt = Date.now();
      emit({ type: "coordinator.started", address: `http://${host}:${port}`, startedAt });
      if (options.startExpiryWorker) startExpiryWorker();
      return port;
    },
    async close() {
      stopExpiryWorker();
      if (!server.listening) return;
      const uptimeMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      emit({ type: "coordinator.closed", uptimeMs });
    },
    startExpiryWorker,
    stopExpiryWorker,
  };
}

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const url = (path: string) => `${options.baseUrl.replace(/\/$/, "")}${path}`;
  const post = (path: string, body: unknown) => requestJson(url(path), "POST", body, options.token, path.replace(/^\/v1\//, ""));
  return {
    async register(signed) { return (await post("/v1/register", signed)).node; },
    async heartbeat(signed) { return (await post("/v1/heartbeat", signed)).node; },
    async unregister(signed) { await post("/v1/unregister", signed); },
    async nodes() { return (await requestJson(url("/v1/nodes"), "GET", undefined, options.token, "nodes")).nodes; },
    async status() { return requestJson(url("/v1/status"), "GET", undefined, options.token, "status"); },
    registerWithIdentity(identity, baseUrl, capacity) { return this.register(createSignedRegistration(identity, baseUrl, capacity ? { capacity } : {})); },
    heartbeatWithIdentity(identity, nodeId, capacity) { return this.heartbeat(createSignedHeartbeat(identity, nodeId, capacity ? { capacity } : {})); },
    unregisterWithIdentity(identity, nodeId) { return this.unregister(createSignedUnregister(identity, nodeId)); },
    registerLibp2pWithIdentity(identity, descriptor, capacity) { return this.register(createSignedLibp2pRegistration(identity, descriptor, capacity ? { capacity } : {})); },
    heartbeatLibp2pWithIdentity(identity, descriptor, capacity) { return this.heartbeat(createSignedLibp2pHeartbeat(identity, descriptor, capacity ? { capacity } : {})); },
  };
}

function requestJson(urlString: string, method: "GET" | "POST", body: unknown, token: string | undefined, operation: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(urlString); } catch { reject(new RegistryClientError(operation, "config", "invalid coordinator address")); return; }
    const request = parsed.protocol === "https:" ? httpsRequest : parsed.protocol === "http:" ? httpRequest : undefined;
    if (!request) { reject(new RegistryClientError(operation, "config", "unsupported coordinator protocol")); return; }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname + parsed.search, method, headers: { accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) }), ...(token ? { authorization: "Bearer " + token } : {}) } }, (response) => {
      let data = ""; response.setEncoding("utf8"); response.on("data", (chunk: string) => { data += chunk; });
      response.on("end", () => {
        let payload: any = {};
        if (data) { try { payload = JSON.parse(data); } catch { if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) return reject(new RegistryClientError(operation, "protocol", "coordinator returned invalid JSON")); } }
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          const classification: RegistryClientErrorClassification = status === 401 || status === 403 ? "auth" : status >= 500 ? "transient" : status === 400 || status === 404 ? "config" : "protocol";
          return reject(new RegistryClientError(operation, classification, typeof payload?.error === "string" ? payload.error : `coordinator returned ${status}`, status));
        }
        resolve(payload);
      });
    });
    req.on("error", (error) => reject(new RegistryClientError(operation, "transient", error instanceof Error ? error.message : "connection failed")));
    if (serialized !== undefined) req.write(serialized); req.end();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, registry: Registry, token: string | undefined, maxBody: number, emit: (event: CoordinatorEvent) => void, coordinatorStatus: () => unknown): Promise<void> {
  const path = (req.url ?? "/").split("?")[0];
  const isReadiness = req.method === "GET" && (path === "/ready" || path === "/v1/ready");
  if (isReadiness) {
    const persistence = registry.persistenceStatus();
    const ready = persistence.healthy;
    return send(res, ready ? 200 : 503, {
      status: ready ? "ready" : "not-ready",
      protocol: REGISTRY_PROTOCOL_VERSION,
      persistence: { enabled: persistence.enabled, healthy: persistence.healthy, degraded: persistence.degraded },
    });
  }
  if (token && req.headers.authorization !== "Bearer " + token) { emit({ type: "coordinator.request", operation: "auth", outcome: "error" }); return send(res, 401, { error: "unauthorized" }); }
  if (req.method === "GET" && (path === "/health" || path === "/v1/health")) { const persistence = registry.persistenceStatus(); const aggregate = registry.healthSnapshot(); return send(res, 200, { status: persistence.degraded ? "degraded" : "ok", protocol: REGISTRY_PROTOCOL_VERSION, persistence, aggregate, health: aggregate, coordinator: coordinatorStatus() }); }
  if (req.method === "GET" && (path === "/status" || path === "/v1/status")) { const persistence = registry.persistenceStatus(); const aggregate = registry.healthSnapshot(); return send(res, 200, { protocol: REGISTRY_PROTOCOL_VERSION, status: persistence.degraded ? "degraded" : "ok", persistence, aggregate, health: aggregate, coordinator: coordinatorStatus() }); }
  if (req.method === "GET" && (path === "/nodes" || path === "/v1/nodes")) return send(res, 200, { protocol: REGISTRY_PROTOCOL_VERSION, nodes: registry.list() });
  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  try {
    const body = await readBody(req, maxBody);
    if (path === "/register" || path === "/v1/register") { const node = registry.registerSigned(body as SignedRegistration); emit({ type: "coordinator.request", operation: "register", outcome: "success" }); return send(res, 200, { node }); }
    if (path === "/heartbeat" || path === "/v1/heartbeat") { const node = registry.heartbeatSigned(body as SignedHeartbeat); emit({ type: "coordinator.request", operation: "heartbeat", outcome: "success" }); return send(res, 200, { node }); }
    if (path === "/unregister" || path === "/v1/unregister") { registry.unregisterSigned(body as SignedUnregister); emit({ type: "coordinator.request", operation: "unregister", outcome: "success" }); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: "not found" });
  } catch (error) { emit({ type: "coordinator.request", operation: path.replace(/^\/v1\//, "").replace(/^\//, "") || "request", outcome: "error" }); return send(res, 400, { error: error instanceof Error ? error.message : "invalid request" }); }
}
function readBody(req: IncomingMessage, max: number): Promise<unknown> { return new Promise((resolve, reject) => { let data = ""; let size = 0; req.setEncoding("utf8"); req.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > max) { reject(new Error("request body too large")); req.destroy(); } else data += chunk; }); req.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid JSON")); } }); req.on("error", reject); }); }
function send(res: ServerResponse, status: number, payload: unknown): void { const body = JSON.stringify(payload); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" }); res.end(body); }
