/**
 * Cross-process registry protocol (Milestone 045).
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "http";
import { request as httpsRequest } from "https";
import type { Identity } from "../identity/index.js";
import type { NodeCapacity, P2PRegistrationDescriptor, Registry, SignedHeartbeat, SignedRegistration, SignedUnregister } from "./index.js";
import { createSignedHeartbeat, createSignedLibp2pHeartbeat, createSignedLibp2pRegistration, createSignedRegistration, createSignedUnregister } from "./index.js";
import { defaultMetrics, type MetricsRegistry } from "../metrics/index.js";
import { defaultEvents, type EventStore } from "../events/index.js";
import { ConditionEvaluator, type Condition } from "../conditions/index.js";
import type { AuthorityControlPlane } from "../coordinator-ha/authority-control-plane.js";
import type { CoordinatorAuthorityRuntime } from "../coordinator-ha/runtime.js";

export const REGISTRY_PROTOCOL_VERSION = 1;
export const DEFAULT_REGISTRY_COORDINATOR_PORT = 4190;
export interface CoordinatorLogger { info?: (message: string, details?: Record<string, string | number | boolean>) => void; warn?: (message: string, details?: Record<string, string | number | boolean>) => void; error?: (message: string, details?: Record<string, string | number | boolean>) => void; }
export interface CoordinatorDiscoveryDiagnostic { state: "fresh" | "cached" | "stale" | "unavailable" | "reconnecting"; ageMs?: number; endpointCount: number; freshAvailable: boolean; }
export type CoordinatorEvent =
  | { type: "coordinator.started" | "coordinator.closed"; address?: string; startedAt?: number; uptimeMs?: number }
  | { type: "coordinator.request"; operation: string; outcome: "success" | "error" }
  | { type: "coordinator.expiry"; expired: number };
export interface RegistryCoordinatorOptions {
  registry: Registry;
  token?: string;
  host?: string;
  maxBodyBytes?: number;
  logger?: CoordinatorLogger;
  onEvent?: (event: CoordinatorEvent) => void;
  onLifecycleEvent?: (event: CoordinatorEvent) => void;
  metrics?: MetricsRegistry;
  events?: EventStore;
  conditions?: ConditionEvaluator;
  discovery?: () => CoordinatorDiscoveryDiagnostic;
  expiryIntervalMs?: number;
  startExpiryWorker?: boolean;
  authorityControlPlane?: AuthorityControlPlane;
  authorityRuntime?: CoordinatorAuthorityRuntime;
}
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
  const metrics = options.metrics ?? defaultMetrics;
  const events = options.events ?? defaultEvents;
  const conditions = options.conditions ?? new ConditionEvaluator();
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const emit = (event: CoordinatorEvent): void => {
    try { options.onEvent?.(event); } catch {}
    try { if (options.onLifecycleEvent && options.onLifecycleEvent !== options.onEvent) options.onLifecycleEvent(event); } catch {}
    try { const level = event.type === "coordinator.request" && event.outcome === "error" ? "error" : "info"; options.logger?.[level]?.(event.type, event.type === "coordinator.request" ? { operation: event.operation, outcome: event.outcome } : event.type === "coordinator.expiry" ? { expired: event.expired } : event.address ? { address: event.address } : {}); } catch {}
    try {
      if (event.type === "coordinator.started" || event.type === "coordinator.closed") {
        events.append({ version: 1, timestamp: Date.now(), component: "coordinator", type: event.type, severity: "info", details: {} });
      } else if (event.type === "coordinator.request") {
        events.append({ version: 1, timestamp: Date.now(), component: "coordinator", type: event.type, severity: event.outcome === "error" ? "error" : "info", details: { result: event.outcome } });
      }
    } catch {}
  };
  const server = createServer((req, res) => { void handle(req, res, options.registry, options.token, maxBody, emit, () => coordinatorStatus(), metrics, events, conditions, options.discovery, options.authorityControlPlane, options.authorityRuntime); });
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
        if (expired.length > 0) { metrics.increment("coordinator_expirations_total", expired.length, { reason: "expired" }); emit({ type: "coordinator.expiry", expired: expired.length }); }
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

function normalizeRecoveryReason(reason: string | undefined): string {
  switch (reason) {
    case "authorization_required": return "operator_authorization_required";
    case "authorization_invalid": return "invalid_authorization";
    case "authorization_expired": return "authorization_expired";
    case "authorization_revoked": return "authorization_revoked";
    case "authorization_accepted": return "authorization_accepted";
    case "missing_evidence": return "missing_evidence";
    case "stale_evidence": return "stale_evidence";
    case "ownership_conflict": return "ownership_conflict";
    case "validation_failure": return "validation_failed";
    case "corrupt_issuer":
    case "corrupt_candidate":
    case "corrupt_ownership": return "corrupt_persistence";
    case "execution_failed": return "execution_failed";
    case "verification_failed": return "verification_failed";
    case "replay_detected": return "replay_detected";
    case "manual_reject": return "manual_reject";
    case "interrupted": return "interrupted";
    case "aborted": return "aborted";
    case "executed": return "executed";
    default: return reason ?? "validation_failed";
  }
}

function sanitizeRecoveryPayload(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return { state: "rejected", reason: "invalid_response", authorized: false, executed: false, verified: false };
  }
  const value = input as Record<string, unknown>;
  const rawState = typeof value.state === "string" ? value.state : "rejected";
  const rawReason = typeof value.reason === "string" ? value.reason : (typeof value.recoveryReason === "string" ? value.recoveryReason : undefined);
  const result: Record<string, unknown> = {
    state: rawState === "verification-failed" ? "rejected" : rawState,
    reason: normalizeRecoveryReason(rawReason === "verification_failed" ? "verification_failed" : rawReason),
    decision: typeof value.decision === "string" ? value.decision : "denied",
    authorized: Boolean(value.authorized),
    executed: Boolean(value.executed),
    verified: Boolean(value.verified),
  };
  if (typeof value.authorizationRequired === "boolean") result.authorizationRequired = value.authorizationRequired;
  if (typeof value.recoveryState === "string") result.recoveryState = value.recoveryState;
  if (typeof value.recoveryReason === "string") result.recoveryReason = normalizeRecoveryReason(value.recoveryReason);
  if (typeof value.persisted === "boolean") result.persisted = value.persisted;
  if (typeof value.persistenceState === "string") result.persistenceState = value.persistenceState;
  if (typeof value.ownershipConflict === "boolean") result.ownershipConflict = value.ownershipConflict;
  if (typeof value.observedAt === "number") result.observedAt = value.observedAt;
  return result;
}

function classifyRecoveryFailure(payload: Record<string, unknown>): number {
  const state = String(payload.state ?? "");
  const reason = String(payload.reason ?? "");
  if (state === "degraded" || state === "unavailable" || state === "conflicted" || reason === "corrupt_persistence" || reason === "ownership_conflict") return 503;
  if (state === "authorization-required" || reason === "operator_authorization_required") return 403;
  if (state === "aborted" || state === "interrupted" || reason === "verification_failed") return 409;
  if (reason === "missing_evidence" || reason === "stale_evidence" || reason === "invalid_authorization" || reason === "authorization_expired" || reason === "authorization_revoked" || reason === "validation_failed") return 422;
  if (reason === "invalid_request" || reason === "malformed_request" || reason === "request_body_too_large") return 400;
  return 200;
}

function resolveRecoveryStatus(payload: Record<string, unknown>, fallbackStatus: number): number {
  const classified = classifyRecoveryFailure(payload);
  if (classified !== 200) return classified;
  return fallbackStatus >= 400 ? fallbackStatus : 200;
}

function normalizeRouteLabel(route: string): string {
  if (route === "ready" || route === "health" || route === "status" || route === "nodes" || route === "register" || route === "heartbeat" || route === "unregister" || route === "metrics" || route === "pieces" || route === "conditions" || route === "events") return route;
  if (route === "recovery" || route.startsWith("recovery/")) return "recovery";
  return "request";
}

async function handle(req: IncomingMessage, res: ServerResponse, registry: Registry, token: string | undefined, maxBody: number, emit: (event: CoordinatorEvent) => void, coordinatorStatus: () => unknown, metrics: MetricsRegistry, events: EventStore, conditions: ConditionEvaluator, discovery?: () => CoordinatorDiscoveryDiagnostic, authorityControlPlane?: AuthorityControlPlane, authorityRuntime?: CoordinatorAuthorityRuntime): Promise<void> {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const route = path.replace(/^\/v1\//, "").replace(/^\//, "") || "request";
  const safeRoute = normalizeRouteLabel(route);
  const recoveryMatch = /^recovery(?:\/(inspect|diagnose|prepare|execute|verify))?$/.exec(route);
  metrics.increment("coordinator_requests_total", 1, { route: safeRoute });
  const finish = (status: number) => {
    metrics.observe("coordinator_request_duration_ms", Date.now() - started, { route: safeRoute });
    metrics.set("coordinator_persistence_healthy", registry.persistenceStatus().healthy ? 1 : 0);
    const snapshot = registry.healthSnapshot();
    metrics.set("coordinator_nodes_total", snapshot.totalNodes);
    metrics.set("coordinator_nodes_available", snapshot.availableNodes);
    metrics.set("coordinator_capacity_bytes", snapshot.totalCapacityBytes);
    metrics.set("coordinator_used_bytes", snapshot.usedCapacityBytes);
    if (status >= 400) metrics.increment("coordinator_request_errors_total", 1, { status_class: status >= 500 ? "5xx" : "4xx" });
  };
  const respond = (status: number, payload: unknown) => { finish(status); send(res, status, payload); };
  const isReadiness = req.method === "GET" && (path === "/ready" || path === "/v1/ready");
  if (isReadiness) {
    const persistence = registry.persistenceStatus();
    const ready = persistence.healthy;
    return respond(ready ? 200 : 503, {
      status: ready ? "ready" : "not-ready",
      protocol: REGISTRY_PROTOCOL_VERSION,
      persistence: { enabled: persistence.enabled, healthy: persistence.healthy, degraded: persistence.degraded },
    });
  }
  if (req.method === "GET" && (path === "/metrics" || path === "/v1/metrics")) return respond(200, metrics.snapshot());
  if (token && req.headers.authorization !== "Bearer " + token) { emit({ type: "coordinator.request", operation: "auth", outcome: "error" }); return respond(401, { error: "unauthorized" }); }
  if (req.method === "GET" && (path === "/conditions" || path === "/v1/conditions")) { const aggregate = registry.healthSnapshot(); const persistence = registry.persistenceStatus(); const safeDiscovery = discovery?.(); return respond(200, { protocol: REGISTRY_PROTOCOL_VERSION, ...(safeDiscovery ? { discovery: safeDiscovery } : {}), conditions: conditions.evaluate({ coordinator: { persistenceHealthy: persistence.healthy, availableNodes: aggregate.availableNodes, unavailableNodes: aggregate.unavailableNodes, ...(safeDiscovery ? { discovery: safeDiscovery } : {}) }, metrics: metrics.snapshot() }), events: events.recent(100) }); }
  if (req.method === "GET" && (path === "/health" || path === "/v1/health")) { const persistence = registry.persistenceStatus(); const aggregate = registry.healthSnapshot(); const safeDiscovery = discovery?.(); return respond(200, { status: persistence.degraded ? "degraded" : "ok", protocol: REGISTRY_PROTOCOL_VERSION, persistence, aggregate, health: aggregate, coordinator: coordinatorStatus(), ...(safeDiscovery ? { discovery: safeDiscovery } : {}), conditions: conditions.evaluate({ coordinator: { persistenceHealthy: persistence.healthy, availableNodes: aggregate.availableNodes, unavailableNodes: aggregate.unavailableNodes, ...(safeDiscovery ? { discovery: safeDiscovery } : {}) }, metrics: metrics.snapshot() }), events: events.recent(100) }); }
  if (req.method === "GET" && (path === "/events" || path === "/v1/events")) return respond(200, events.snapshot());
  if (req.method === "GET" && (path === "/status" || path === "/v1/status")) { const persistence = registry.persistenceStatus(); const aggregate = registry.healthSnapshot(); const safeDiscovery = discovery?.(); return respond(200, { protocol: REGISTRY_PROTOCOL_VERSION, status: persistence.degraded ? "degraded" : "ok", persistence, aggregate, health: aggregate, coordinator: coordinatorStatus(), ...(safeDiscovery ? { discovery: safeDiscovery } : {}), conditions: conditions.evaluate({ coordinator: { persistenceHealthy: persistence.healthy, availableNodes: aggregate.availableNodes, unavailableNodes: aggregate.unavailableNodes, ...(safeDiscovery ? { discovery: safeDiscovery } : {}) }, metrics: metrics.snapshot() }), events: events.recent(100) }); }
  if (req.method === "GET" && (path === "/nodes" || path === "/v1/nodes")) return respond(200, { protocol: REGISTRY_PROTOCOL_VERSION, nodes: registry.list() });
  if (recoveryMatch) {
    const action = recoveryMatch[1] ?? "inspect";
    const stableStatus = (payload: Record<string, unknown>, status: number): number => resolveRecoveryStatus(payload, status);
    if (!authorityRuntime && !authorityControlPlane) return respond(503, { error: "recovery runtime is unavailable", state: "degraded", reason: "corrupt_persistence" });
    try {
      if (req.method === "GET" && action === "inspect") {
        const evidence = (() => {
          const candidate = url.searchParams.get("evidence");
          if (!candidate) return undefined;
          try { return JSON.parse(candidate); } catch { throw new Error("invalid recovery evidence"); }
        })();
        const result = authorityRuntime?.inspectRecovery(evidence as never) ?? authorityControlPlane?.inspectRecovery(evidence as never);
        const payload = sanitizeRecoveryPayload(result ?? { state: "authorization-required", reason: "operator_authorization_required", decision: "requires_operator_authorization", authorized: false, executed: false, verified: false });
        return respond(200, payload);
      }
      if (req.method === "POST") {
        const body = await readBody(req, maxBody);
        if (!body || typeof body !== "object") return respond(400, { error: "invalid request", state: "rejected", reason: "malformed_request" });
        const object = body as Record<string, unknown>;
        const evidence = object.evidence as Record<string, unknown> | undefined;
        const authorization = object.authorization as Record<string, unknown> | undefined;
        const actionValue = typeof object.action === "string" ? object.action : undefined;
        const requestAuthorization = object.requestAuthorization as Record<string, unknown> | undefined;
        if (action === "diagnose") {
          const result = authorityRuntime?.diagnoseRecoveryDrill(evidence as never) ?? authorityControlPlane?.diagnoseRecoveryDrill(evidence as never);
          return respond(200, sanitizeRecoveryPayload(result ?? { state: "rejected", reason: "missing_evidence", decision: "denied", authorized: false, executed: false, verified: false }));
        }
        if (action === "prepare") {
          if (!evidence) return respond(400, { error: "missing recovery evidence", state: "rejected", reason: "missing_evidence" });
          const result = authorityControlPlane?.prepareRecoveryDrill(evidence as never, authorization as never) ?? authorityRuntime?.inspectRecoveryDrill(evidence as never);
          const payload = sanitizeRecoveryPayload(result ?? { state: "rejected", reason: "missing_evidence", decision: "denied", authorized: false, executed: false, verified: false });
          if (payload.state === "authorization-required" || payload.reason === "operator_authorization_required") return respond(403, payload);
          if (payload.state === "conflicted" || payload.reason === "ownership_conflict") return respond(503, payload);
          if (payload.state === "rejected" || payload.reason === "authorization_expired" || payload.reason === "authorization_revoked" || payload.reason === "invalid_authorization" || payload.reason === "validation_failed") return respond(422, payload);
          return respond(stableStatus(payload, 200), payload);
        }
        if (action === "execute") {
          if (!evidence) return respond(400, { error: "missing recovery evidence", state: "rejected", reason: "missing_evidence" });
          const result = authorityControlPlane?.executeRecoveryDrill((actionValue as "inspect" | "approve" | "reset" | "fence") ?? "approve", evidence as never, authorization as never) ?? authorityRuntime?.inspectRecoveryDrill(evidence as never);
          const payload = sanitizeRecoveryPayload(result ?? { state: "rejected", reason: "missing_evidence", decision: "denied", authorized: false, executed: false, verified: false });
          if (payload.state === "authorization-required" || payload.reason === "operator_authorization_required") return respond(403, payload);
          if (payload.state === "conflicted" || payload.reason === "ownership_conflict") return respond(503, payload);
          if (payload.state === "rejected" || payload.reason === "authorization_expired" || payload.reason === "authorization_revoked" || payload.reason === "invalid_authorization" || payload.reason === "validation_failed") return respond(422, payload);
          return respond(stableStatus(payload, 200), payload);
        }
        if (action === "verify") {
          if (!evidence) return respond(400, { error: "missing recovery evidence", state: "rejected", reason: "missing_evidence" });
          const result = authorityControlPlane?.verifyRecoveryDrill(evidence as never, authorization as never) ?? authorityRuntime?.inspectRecoveryDrill(evidence as never);
          const payload = sanitizeRecoveryPayload(result ?? { state: "rejected", reason: "missing_evidence", decision: "denied", authorized: false, executed: false, verified: false });
          if (payload.state === "verification-failed" || payload.reason === "verification_failed") return respond(400, payload);
          if (payload.state === "authorization-required" || payload.reason === "operator_authorization_required") return respond(403, payload);
          if (payload.state === "conflicted" || payload.reason === "ownership_conflict") return respond(503, payload);
          if (payload.state === "rejected" || payload.reason === "authorization_expired" || payload.reason === "authorization_revoked" || payload.reason === "invalid_authorization" || payload.reason === "validation_failed") return respond(422, payload);
          return respond(stableStatus(payload, 200), payload);
        }
        if (requestAuthorization) {
          const result = authorityControlPlane?.requestRecoveryAuthorization(requestAuthorization as never) ?? authorityRuntime?.inspectRecoveryDrill();
          return respond(200, sanitizeRecoveryPayload(result ?? { state: "authorization-required", reason: "operator_authorization_required", decision: "requires_operator_authorization", authorized: false, executed: false, verified: false }));
        }
        return respond(400, { error: "unsupported recovery operation", state: "rejected", reason: "invalid_request" });
      }
      return respond(405, { error: "method not allowed", state: "rejected", reason: "invalid_request" });
    } catch (error) {
      metrics.increment("coordinator_request_errors_total", 1, { status_class: "4xx" });
      emit({ type: "coordinator.request", operation: `recovery.${action ?? "inspect"}`, outcome: "error" });
      const message = error instanceof Error ? error.message : "invalid request";
      const normalized = message.toLowerCase().includes("too large") ? "request_body_too_large" : message.toLowerCase().includes("json") || message.toLowerCase().includes("invalid") ? "invalid_request" : "validation_failed";
      return respond(400, { error: message, state: "rejected", reason: normalized });
    }
  }
  if (req.method !== "POST") return respond(405, { error: "method not allowed" });
  try {
    const body = await readBody(req, maxBody);
    if (path === "/register" || path === "/v1/register") { const node = registry.registerSigned(body as SignedRegistration); metrics.increment("coordinator_registrations_total", 1, { result: "success" }); emit({ type: "coordinator.request", operation: "register", outcome: "success" }); return respond(200, { node }); }
    if (path === "/heartbeat" || path === "/v1/heartbeat") { const node = registry.heartbeatSigned(body as SignedHeartbeat); metrics.increment("coordinator_heartbeats_total", 1, { result: "success" }); emit({ type: "coordinator.request", operation: "heartbeat", outcome: "success" }); return respond(200, { node }); }
    if (path === "/unregister" || path === "/v1/unregister") { registry.unregisterSigned(body as SignedUnregister); metrics.increment("coordinator_unregisters_total", 1, { result: "success" }); emit({ type: "coordinator.request", operation: "unregister", outcome: "success" }); return respond(200, { ok: true }); }
    return respond(404, { error: "not found" });
  } catch (error) { metrics.increment("coordinator_request_errors_total", 1, { status_class: "4xx" }); emit({ type: "coordinator.request", operation: route, outcome: "error" }); return respond(400, { error: error instanceof Error ? error.message : "invalid request" }); }
}
function readBody(req: IncomingMessage, max: number): Promise<unknown> { return new Promise((resolve, reject) => { let data = ""; let size = 0; req.setEncoding("utf8"); req.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > max) { reject(new Error("request body too large")); return; } data += chunk; }); req.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid JSON")); } }); req.on("error", reject); }); }
function send(res: ServerResponse, status: number, payload: unknown): void { const body = JSON.stringify(payload); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" }); res.end(body); }
