/**
 * OpenStore Node Registry (OPENSTORE-010)
 *
 * In-memory authenticated registry for storage node discovery.
 * Uses Ed25519 signatures to prove ownership; no private keys stored.
 * No database, no P2P, stdlib only.
 */

import { randomBytes } from "crypto";
import { defaultMetrics } from "../metrics/index.js";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { signMessage, verifyMessage } from "../identity/index.js";
import type { Identity } from "../identity/index.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";
import type { P2PPeerDescriptor } from "../p2p/index.js";
import { validateP2PPeerDescriptor } from "../p2p/index.js";
import { peerIdFromOpenStorePublicKey } from "../p2p/identity-binding.js";
import { DEFAULT_MAX_REPLAY_CACHE_ENTRIES } from "../auth/index.js";

export const REGISTRY_VERSION = 1;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Neutral score for newly registered nodes (OPENSTORE-016). */
export const DEFAULT_RELIABILITY_SCORE = 50;
/**
 * Prior weight for Bayesian reliability smoothing.
 * Higher = slower movement. Keeps new nodes neutral and
 * makes successful heartbeats improve gradually.
 */
export const RELIABILITY_PRIOR_WEIGHT = 10;

const NONCE_BYTES = 16;

function getAllocated(cap: NodeCapacity): number {
  return (cap.allocatedBytes ?? cap.totalBytes ?? 0) as number;
}

function registrationPayload(baseUrl: string, capacity: NodeCapacity | undefined, timestamp: string, nonce: string): string {
  if (capacity) {
    const total = getAllocated(capacity);
    return `REGISTER\n${baseUrl}\n${total}\n${capacity.usedBytes}\n${capacity.availableBytes}\n${timestamp}\n${nonce}`;
  }
  return `REGISTER\n${baseUrl}\n${timestamp}\n${nonce}`;
}

function heartbeatPayload(nodeId: string, capacity: NodeCapacity | undefined, timestamp: string, nonce: string): string {
  if (capacity) {
    const total = getAllocated(capacity);
    return `HEARTBEAT\n${nodeId}\n${total}\n${capacity.usedBytes}\n${capacity.availableBytes}\n${timestamp}\n${nonce}`;
  }

  return `HEARTBEAT\n${nodeId}\n${timestamp}\n${nonce}`;
}

function descriptorPayload(kind: "REGISTER" | "HEARTBEAT", descriptor: P2PPeerDescriptor, capacity: NodeCapacity | undefined, timestamp: string, nonce: string): string {
  const capacityPayload = capacity === undefined ? "" : JSON.stringify({
    allocatedBytes: getAllocated(capacity),
    usedBytes: capacity.usedBytes,
    availableBytes: capacity.availableBytes,
  });
  return `${kind}\n${JSON.stringify(descriptor)}\n${capacityPayload}\n${timestamp}\n${nonce}`;
}

export interface NodeCapacity {
  allocatedBytes?: number;
  usedBytes: number;
  availableBytes: number;
  physicalBytes?: number;
  usableBytes?: number;
  /** @deprecated use allocatedBytes */
  totalBytes?: number;
}

/**
 * Reliability/health tracking for a node (OPENSTORE-016, extended by OPENSTORE-018).
 * Only counters and derived scores are stored — no sensitive data.
 *
 * Heartbeat health and storage-audit health are tracked SEPARATELY:
 * - `successfulHeartbeats`/`missedHeartbeats`/`score` reflect only
 *   heartbeat/availability history. Storage audits never touch them.
 * - `successfulAudits`/`failedAudits`/`storageScore` reflect only
 *   metadata-only piece verification results. Heartbeats never touch them.
 * This keeps either signal from silently distorting the other.
 */
export interface NodeReliability {
  /** Number of successful authenticated heartbeats observed. */
  successfulHeartbeats: number;
  /** Number of missed/expired heartbeat windows observed. */
  missedHeartbeats: number;
  /** Deterministic heartbeat score from 0–100 derived from heartbeat counters. */
  score: number;
  /** Number of pieces that verified healthy during storage audits. */
  successfulAudits: number;
  /** Number of pieces that verified missing/corrupted during storage audits. */
  failedAudits: number;
  /** Deterministic storage score from 0–100 derived from audit counters. */
  storageScore: number;
}

export interface NodeRecord {
  nodeId: string;
  publicKey: string;
  baseUrl: string;
  available: boolean;
  lastSeen: number;
  capacity: NodeCapacity;
  reliability: NodeReliability;
  transport?: "http" | "libp2p";
  multiaddr?: string;
  identityBinding?: string;
  capabilities?: { pieceStore: boolean; pieceGet: boolean; pieceDelete: boolean; maxPieceBytes?: number };
  lifecycle?: "sharing" | "draining" | "released";
}

/** Public descriptor submitted by a libp2p node. It never contains private key material. */
export type P2PRegistrationDescriptor = P2PPeerDescriptor;

/**
 * Deterministic reliability score from 0–100.
 * Bayesian smoothing with a neutral prior keeps new nodes at 50,
 * improves gradually with successes, and drops with misses.
 * Identical (success, missed) inputs always produce the same score.
 */
export function computeReliabilityScore(successfulHeartbeats: number, missedHeartbeats: number): number {
  const s = Math.max(0, Math.floor(successfulHeartbeats));
  const m = Math.max(0, Math.floor(missedHeartbeats));
  const prior = RELIABILITY_PRIOR_WEIGHT;
  const priorSuccess = (prior * DEFAULT_RELIABILITY_SCORE) / 100;
  const score = Math.round((100 * (s + priorSuccess)) / (s + m + prior));
  return Math.min(100, Math.max(0, score));
}

/**
 * Deterministic storage-health score from 0–100.
 * Same neutral-prior smoothing as heartbeats, applied to audit counters.
 */
export function computeStorageScore(successfulAudits: number, failedAudits: number): number {
  return computeReliabilityScore(successfulAudits, failedAudits);
}

/** Neutral storage health for nodes with no audit history. */
export const DEFAULT_STORAGE_SCORE = DEFAULT_RELIABILITY_SCORE;

export function defaultReliability(): NodeReliability {
  return {
    successfulHeartbeats: 0,
    missedHeartbeats: 0,
    score: DEFAULT_RELIABILITY_SCORE,
    successfulAudits: 0,
    failedAudits: 0,
    storageScore: DEFAULT_STORAGE_SCORE,
  };
}

function validateReliability(rel: unknown): NodeReliability {
  if (!rel || typeof rel !== "object" || Array.isArray(rel)) throw new Error("malformed node record: invalid reliability");
  const r = rel as Record<string, unknown>;
  for (const f of ["successfulHeartbeats", "missedHeartbeats", "score"] as const) {
    if (typeof r[f] !== "number" || !Number.isInteger(r[f] as number) || (r[f] as number) < 0) {
      throw new Error(`malformed node record: invalid reliability ${f}`);
    }
  }
  const s = r["successfulHeartbeats"] as number;
  const m = r["missedHeartbeats"] as number;
  const score = r["score"] as number;
  if (score > 100) throw new Error("malformed node record: invalid reliability score");
  // Audit fields optional for backward compat (pre-018 files lack them).
  let sA = 0;
  let fA = 0;
  if (r["successfulAudits"] !== undefined) {
    if (typeof r["successfulAudits"] !== "number" || !Number.isInteger(r["successfulAudits"] as number) || (r["successfulAudits"] as number) < 0) {
      throw new Error("malformed node record: invalid reliability successfulAudits");
    }
    sA = r["successfulAudits"] as number;
  }
  if (r["failedAudits"] !== undefined) {
    if (typeof r["failedAudits"] !== "number" || !Number.isInteger(r["failedAudits"] as number) || (r["failedAudits"] as number) < 0) {
      throw new Error("malformed node record: invalid reliability failedAudits");
    }
    fA = r["failedAudits"] as number;
  }
  if (r["storageScore"] !== undefined) {
    if (typeof r["storageScore"] !== "number" || !Number.isInteger(r["storageScore"] as number) || (r["storageScore"] as number) < 0 || (r["storageScore"] as number) > 100) {
      throw new Error("malformed node record: invalid reliability storageScore");
    }
  }
  // Recompute both scores deterministically from counters so the
  // invariant score == f(counters) always holds.
  return {
    successfulHeartbeats: s,
    missedHeartbeats: m,
    score: computeReliabilityScore(s, m),
    successfulAudits: sA,
    failedAudits: fA,
    storageScore: computeStorageScore(sA, fA),
  };
}

export interface RegistryOptions {
  heartbeatTimeoutMs?: number;
  maxClockSkewMs?: number;
  /** Maximum remembered signed-request nonces. */
  maxReplayCacheEntries?: number;
  /** Optional filesystem hooks for deterministic persistence failure tests. */
  persistenceIo?: Partial<RegistryPersistenceIo>;
  /** Optional file path for persistent storage. If omitted, registry is in-memory only. */
  persistencePath?: string;
  /** Optional safe observer for registry lifecycle and persistence events. */
  logger?: RegistryLogger;
  onEvent?: (event: RegistryEvent) => void;
  onLifecycleEvent?: (event: RegistryEvent) => void;
}

export interface RegistryPersistenceIo {
  chmodSync(path: string, mode: number): void;
  closeSync(fd: number): void;
  fsyncSync(fd: number): void;
  mkdirSync(path: string, options: { recursive: true }): void;
  openSync(path: string, flags: string): number;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  writeFileSync(path: string, data: string, options: { mode: number }): void;
}

export interface RegistryLogger {
  info?: (message: string, details?: Record<string, number | string | boolean>) => void;
  warn?: (message: string, details?: Record<string, number | string | boolean>) => void;
  error?: (message: string, details?: Record<string, number | string | boolean>) => void;
}

export type RegistryEvent =
  | { type: "registry.started"; persistence: "enabled" | "disabled"; timestamp?: number }
  | { type: "persistence.load"; outcome: "success" | "missing" | "invalid" | "error"; records: number }
  | { type: "persistence.write"; outcome: "success" | "error"; records: number }
  | { type: "persistence.degraded"; degraded: boolean; operation: "load" | "write" }
  | { type: "node.registered" | "node.re-registered" | "node.heartbeat-accepted" | "node.heartbeat-rejected" | "node.registration-rejected" | "node.expired" | "node.unregistered"; nodeId: string; timestamp?: number; available?: boolean; transport?: "http" | "libp2p"; state?: string; operation?: string; classification?: string };

export interface ExpiredNodeInfo { nodeId: string; lastSeen: number; missedHeartbeats: number; }

export interface PersistenceStatus {
  enabled: boolean;
  healthy: boolean;
  degraded: boolean;
  lastLoadOutcome?: "success" | "missing" | "invalid" | "error";
  lastWriteOutcome?: "success" | "error";
}

export interface RegistryHealthSnapshot {
  totalNodes: number;
  availableNodes: number;
  unavailableNodes: number;
  totalCapacityBytes: number;
  usedCapacityBytes: number;
  availableCapacityBytes: number;
  averageReliabilityScore: number;
  averageStorageScore: number;
  heartbeatTimeoutMs: number;
  lastMutationAt?: number;
  lastExpiryAt?: number;
  lastExpiryCount: number;
}

/**
 * Aggregated result of one storage audit for one node (OPENSTORE-018).
 * Counts only pieces that produced a verification response; transport
 * errors and unreachable nodes are excluded by the audit module and
 * must not be recorded here.
 */
export interface StorageAuditResult {
  /** Unique ID of the audit run (used for idempotency). */
  auditId: string;
  /** Pieces that verified healthy (existed and hashed to the expected ID). */
  healthy: number;
  /** Pieces that verified missing or corrupted. */
  unhealthy: number;
}

export interface Registry {
  readonly version: number;
  readonly heartbeatTimeoutMs: number;
  register(baseUrl: string, identity: Identity, capacity?: NodeCapacity): NodeRecord;
  registerSigned(signed: SignedRegistration): NodeRecord;
  registerSignedInternal(signed: SignedRegistration): NodeRecord;
  registerLibp2pSigned(signed: SignedLibp2pRegistration): NodeRecord;
  heartbeat(nodeId: string, identity: Identity, capacity?: NodeCapacity): NodeRecord;
  heartbeatSigned(signed: SignedHeartbeat): NodeRecord;
  heartbeatSignedInternal(signed: SignedHeartbeat): NodeRecord;
  heartbeatLibp2pSigned(signed: SignedLibp2pHeartbeat): NodeRecord;
  unregister(nodeId: string, identity: Identity): void;
  unregisterSigned(signed: SignedUnregister): void;
  /**
   * Record a storage-audit outcome into a node's storage health.
   * Updates ONLY audit counters/storageScore — heartbeat statistics
   * are never touched. Recording the same `auditId` twice for the
   * same node is a no-op (no double-counting).
   */
  recordStorageAudit(nodeId: string, result: StorageAuditResult): NodeRecord;
  list(): NodeRecord[];
  listAvailable(): NodeRecord[];
  get(nodeId: string): NodeRecord | undefined;
  getAvailableEndpoints(): StorageNodeEndpoint[];
  registerDiscoveredPeer(peer: P2PPeerDescriptor, options?: { availableBytes?: number; usedBytes?: number; reliabilityScore?: number }): NodeRecord;
  removeDiscoveredPeer(nodeId: string): void;
  pruneExpired(): ExpiredNodeInfo[];
  healthSnapshot(): RegistryHealthSnapshot;
  persistenceStatus(): PersistenceStatus;
}

export interface SignedRegistration {
  baseUrl: string;
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
  capacity?: NodeCapacity;
  descriptor?: P2PRegistrationDescriptor;
}

export interface SignedHeartbeat {
  nodeId: string;
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
  capacity?: NodeCapacity;
  descriptor?: P2PRegistrationDescriptor;
}

export interface SignedLibp2pRegistration extends SignedRegistration {
  descriptor: P2PRegistrationDescriptor;
}

export interface SignedLibp2pHeartbeat extends SignedHeartbeat {
  descriptor: P2PRegistrationDescriptor;
}

export interface SignedUnregister {
  nodeId: string;
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export function createRegistry(options: RegistryOptions = {}): Registry {
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const maxReplayCacheEntries = options.maxReplayCacheEntries ?? DEFAULT_MAX_REPLAY_CACHE_ENTRIES;
  if (!Number.isSafeInteger(maxReplayCacheEntries) || maxReplayCacheEntries <= 0) {
    throw new TypeError("maxReplayCacheEntries must be a positive safe integer");
  }
  const persistencePath = options.persistencePath;
  const io: RegistryPersistenceIo = {
    chmodSync,
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    unlinkSync,
    writeFileSync,
    ...options.persistenceIo,
  };
  const nodes = new Map<string, NodeRecord>();
  const seenNonces = new Map<string, number>();
  /** Idempotency keys `${auditId}:${nodeId}` for recorded storage audits. */
  const seenAuditIds = new Set<string>();
  const lifecycleStates = new Map<string, string>();
  let lastMutationAt: number | undefined;
  let lastExpiryAt: number | undefined;
  let lastExpiryCount = 0;
  const MAX_SEEN_AUDIT_IDS = 1000;
  let persistenceDegraded = false;
  let lastLoadOutcome: "success" | "missing" | "invalid" | "error" | undefined;
  let lastWriteOutcome: PersistenceStatus["lastWriteOutcome"];
  const emit = (event: RegistryEvent): void => {
    if (!("timestamp" in event)) event = { ...event, timestamp: Date.now() } as unknown as RegistryEvent;
    try { options.onEvent?.(event); } catch {}
    try { if (options.onLifecycleEvent && options.onLifecycleEvent !== options.onEvent) options.onLifecycleEvent(event); } catch {}
    const level = event.type === "persistence.degraded" && event.degraded ? "warn" : event.type === "persistence.write" && event.outcome === "error" ? "error" : "info";
    try { options.logger?.[level]?.(event.type, event.type === "persistence.load" ? { outcome: event.outcome, records: event.records } : event.type === "persistence.write" ? { outcome: event.outcome, records: event.records } : event.type === "persistence.degraded" ? { degraded: event.degraded, operation: event.operation } : "nodeId" in event ? { nodeId: event.nodeId, ...(event.available === undefined ? {} : { available: event.available }) } : { persistence: event.persistence }); } catch {}
  };
  const markDegraded = (degraded: boolean, operation: "load" | "write"): void => {
    if (persistenceDegraded !== degraded) {
      persistenceDegraded = degraded;
      emit({ type: "persistence.degraded", degraded, operation });
    }
  };

  // --- Persistence helpers ---
  function isValidPersistedRecord(obj: unknown): NodeRecord | null {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const r = obj as Record<string, unknown>;
    if (
      typeof r["nodeId"] !== "string" ||
      typeof r["publicKey"] !== "string" ||
      typeof r["baseUrl"] !== "string" ||
      typeof r["available"] !== "boolean" ||
      typeof r["lastSeen"] !== "number" ||
      !Number.isInteger(r["lastSeen"] as number)
    ) {
      return null;
    }
    // capacity optional for backward compat
    let capacity: NodeCapacity;
    if (r["capacity"] !== undefined) {
      try {
        capacity = validateCapacity(r["capacity"]);
      } catch {
        return null;
      }
    } else {
      capacity = { allocatedBytes: 0, totalBytes: 0, usedBytes: 0, availableBytes: 0 };
    }
    // Validate baseUrl and publicKey
    try {
      validateBaseUrl(r["baseUrl"] as string);
      validatePublicKey(r["publicKey"] as string);
      if (r["lifecycle"] !== undefined) validateLifecycle(r["lifecycle"]);
      const persistedCapabilities = r["capabilities"];
      if (persistedCapabilities && typeof persistedCapabilities === "object" &&
          (persistedCapabilities as Record<string, unknown>).lifecycle !== undefined) {
        validateLifecycle((persistedCapabilities as Record<string, unknown>).lifecycle);
      }
    } catch {
      return null;
    }
    // Reject if private keys present
    if ("privateKey" in r || "recoveryPhrase" in r || "signature" in r) return null;
    // Reliability optional for backward compat (old files lack it) — never sensitive
    let reliability: NodeReliability;
    if (r["reliability"] !== undefined) {
      try {
        reliability = validateReliability(r["reliability"]);
      } catch {
        return null;
      }
    } else {
      reliability = defaultReliability();
    }
    const transport = r["transport"] === "libp2p" ? "libp2p" as const : r["transport"] === "http" ? "http" as const : undefined;
    if (transport === "libp2p") {
      if (typeof r["multiaddr"] !== "string" || typeof r["identityBinding"] !== "string" ||
          !r["capabilities"] || typeof r["capabilities"] !== "object") return null;
      try {
        validateP2PPeerDescriptor({
          nodeId: r["nodeId"], baseUrl: r["baseUrl"], multiaddr: r["multiaddr"],
          identityBinding: r["identityBinding"], identity: { publicKey: r["publicKey"] },
          capabilities: r["capabilities"],
        });
      } catch { return null; }
    }
    return {
      nodeId: r["nodeId"] as string,
      publicKey: r["publicKey"] as string,
      baseUrl: r["baseUrl"] as string,
      available: r["available"] as boolean,
      lastSeen: r["lastSeen"] as number,
      capacity,
      reliability,
      ...(transport === undefined ? {} : {
        transport,
        multiaddr: r["multiaddr"] as string | undefined,
        identityBinding: r["identityBinding"] as string | undefined,
        capabilities: r["capabilities"] as NodeRecord["capabilities"],
        ...(r["lifecycle"] === undefined ? {} : { lifecycle: r["lifecycle"] as NodeRecord["lifecycle"] }),
      }),
    };
  }

  function loadPersisted(): void {
    emit({ type: "registry.started", persistence: persistencePath ? "enabled" : "disabled" });
    if (!persistencePath) return;
    try {
      const data = readFileSync(persistencePath, "utf8");
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        lastLoadOutcome = "invalid"; markDegraded(true, "load"); emit({ type: "persistence.load", outcome: "invalid", records: 0 }); return;
      }
      const rawNodes = parsed["nodes"];
      if (!Array.isArray(rawNodes)) {
        lastLoadOutcome = "invalid"; markDegraded(true, "load"); emit({ type: "persistence.load", outcome: "invalid", records: 0 }); return;
      }
      for (const raw of rawNodes) {
        const rec = isValidPersistedRecord(raw);
        if (rec) nodes.set(rec.nodeId, rec);
      }
      // Recorded-audit idempotency keys (optional, backward compatible).
      const rawSeen = parsed["seenAuditIds"];
      if (Array.isArray(rawSeen)) {
        for (const entry of rawSeen) {
          if (typeof entry === "string" && entry !== "" && entry.length <= 256 && seenAuditIds.size < MAX_SEEN_AUDIT_IDS) {
            seenAuditIds.add(entry);
          }
        }
      }
      lastLoadOutcome = "success"; emit({ type: "persistence.load", outcome: "success", records: nodes.size });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined;
      lastLoadOutcome = code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid" : "error";
      if (lastLoadOutcome !== "missing") markDegraded(true, "load");
      emit({ type: "persistence.load", outcome: lastLoadOutcome, records: 0 });
    }
  }

  function persist(): void {
    if (!persistencePath) return;
    const persistenceStarted = Date.now();
    const payload = JSON.stringify(
      { version: REGISTRY_VERSION, nodes: Array.from(nodes.values()), seenAuditIds: Array.from(seenAuditIds) },
      null,
      2,
    );
    try {
      const dir = dirname(persistencePath);
      io.mkdirSync(dir, { recursive: true });
    } catch {}
    const tmpPath = `${persistencePath}.tmp.${randomBytes(4).toString("hex")}`;
    try {
      io.writeFileSync(tmpPath, payload, { mode: 0o600 });
      // Ensure restrictive perms even if file existed
      io.chmodSync(tmpPath, 0o600);
      // The durability boundary is a flushed temp file, atomic rename, and a
      // flushed parent directory where the platform supports directory fsync.
      const tempFd = io.openSync(tmpPath, "r");
      try {
        io.fsyncSync(tempFd);
      } finally {
        io.closeSync(tempFd);
      }
      io.renameSync(tmpPath, persistencePath);
      try {
        const directoryFd = io.openSync(dirname(persistencePath), "r");
        try {
          io.fsyncSync(directoryFd);
        } finally {
          io.closeSync(directoryFd);
        }
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? (error as { code?: string }).code
          : undefined;
        if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw error;
      }
      lastWriteOutcome = "success";
      defaultMetrics.observe("coordinator_persistence_duration_ms", Date.now() - persistenceStarted);
      markDegraded(false, "write");
      emit({ type: "persistence.write", outcome: "success", records: nodes.size });
    } catch {
      // Clean up tmp on failure, previous file remains intact
      try { io.unlinkSync(tmpPath); } catch {}
      lastWriteOutcome = "error";
      defaultMetrics.increment("coordinator_persistence_errors_total", 1, { result: "error" });
      defaultMetrics.observe("coordinator_persistence_duration_ms", Date.now() - persistenceStarted);
      markDegraded(true, "write");
      emit({ type: "persistence.write", outcome: "error", records: nodes.size });
    }
  }

  // Load persisted state at startup
  loadPersisted();

  function purgeNonces(now: number): void {
    for (const [k, exp] of seenNonces) {
      if (exp < now) seenNonces.delete(k);
    }
  }

  function validateTimestamp(tsStr: string): number {
    const ts = Number(tsStr);
    if (!Number.isInteger(ts) || ts <= 0) throw new Error("invalid timestamp");
    const now = Date.now();
    if (Math.abs(now - ts) > maxClockSkewMs) throw new Error("expired timestamp");
    return ts;
  }

  function validateNonce(nonce: string, now: number, ts: number): void {
    if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("invalid nonce");
    purgeNonces(now);
    if (seenNonces.has(nonce)) throw new Error("replayed nonce");
    while (seenNonces.size >= maxReplayCacheEntries) {
      const oldest = seenNonces.keys().next().value;
      if (oldest === undefined) break;
      seenNonces.delete(oldest);
    }
    seenNonces.set(nonce, ts + maxClockSkewMs);
  }

  function validateBaseUrl(baseUrl: string): void {
    if (typeof baseUrl !== "string" || baseUrl === "") throw new Error("malformed node record: invalid baseUrl");
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("malformed node record: invalid baseUrl");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "libp2p:") {
      throw new Error("malformed node record: baseUrl must be http, https, or libp2p");
    }
  }

  function validatePublicKey(pubkeyB64: string): Buffer {
    if (typeof pubkeyB64 !== "string" || pubkeyB64 === "") throw new Error("malformed node record: invalid publicKey");
    let buf: Buffer;
    try {
      buf = Buffer.from(pubkeyB64, "base64");
      if (buf.length === 0) throw new Error();
    } catch {
      throw new Error("malformed node record: invalid publicKey");
    }
    // Ed25519 SPKI is 44 bytes
    if (buf.length < 32) throw new Error("malformed node record: invalid publicKey");
    return buf;
  }

  function verifySignature(pubkey: Buffer, payload: string, sigB64: string): void {
    let sig: Buffer;
    try {
      sig = Buffer.from(sigB64, "base64");
      if (sig.length !== 64) throw new Error();
    } catch {
      throw new Error("invalid signature");
    }
    const ok = verifyMessage(pubkey, Buffer.from(payload, "utf8"), sig);
    if (!ok) throw new Error("invalid signature");
  }

  function nodeIdFromPublicKey(pubkeyB64: string): string {
    // Use base64 SPKI as nodeId (unique, stable)
    return pubkeyB64;
  }

  function validateLifecycle(value: unknown): "sharing" | "draining" | "released" {
    if (value !== "sharing" && value !== "draining" && value !== "released") {
      throw new Error("malformed node record: invalid lifecycle state");
    }
    return value;
  }

  function validateCapacity(cap: unknown): NodeCapacity {
    if (!cap || typeof cap !== "object" || Array.isArray(cap)) throw new Error("malformed node record: invalid capacity");
    const c = cap as Record<string, unknown>;
    // Accept allocatedBytes or totalBytes
    const totalRaw = c["allocatedBytes"] ?? c["totalBytes"];
    if (typeof totalRaw !== "number" || !Number.isSafeInteger(totalRaw as number) || (totalRaw as number) <= 0) {
      throw new Error("malformed node record: invalid capacity allocatedBytes");
    }

    for (const f of ["usedBytes", "availableBytes"] as const) {
      if (typeof c[f] !== "number" || !Number.isSafeInteger(c[f] as number) || (c[f] as number) < 0) {
        throw new Error(`malformed node record: invalid capacity ${f}`);
      }
    }
    const total = totalRaw as number;
    const used = c["usedBytes"] as number;
    const available = c["availableBytes"] as number;
    if (used > Number.MAX_SAFE_INTEGER - available || used + available !== total) {
      if (used > total || available !== total - used) {
        throw new Error("malformed node record: capacity inconsistent");
      }
    }
    const physical = c["physicalBytes"];
    const usable = c["usableBytes"];
    if (physical !== undefined && (!Number.isSafeInteger(physical) || (physical as number) <= 0) ||
        usable !== undefined && (!Number.isSafeInteger(usable) || (usable as number) <= 0)) {
      throw new Error("malformed node record: invalid filesystem capacity");
    }
    if (physical !== undefined && usable !== undefined && ((usable as number) > (physical as number) || total > (usable as number))) {
      throw new Error("malformed node record: filesystem capacity inconsistent");
    }
    return {
      allocatedBytes: total, totalBytes: total, usedBytes: used, availableBytes: available,
      ...(physical === undefined ? {} : { physicalBytes: physical as number }),
      ...(usable === undefined ? {} : { usableBytes: usable as number }),
    };
  }

  function prune(): ExpiredNodeInfo[] {
    const now = Date.now();
    let changed = false;
    const expired: ExpiredNodeInfo[] = [];
    for (const [, rec] of nodes) {
      if (now - rec.lastSeen > heartbeatTimeoutMs) {
        if (rec.available) {
          // Single deterministic miss per available → expired transition.
          // Repeated prune() calls while already expired do not add misses.
          rec.available = false;
          rec.reliability.missedHeartbeats += 1;
          rec.reliability.score = computeReliabilityScore(
            rec.reliability.successfulHeartbeats,
            rec.reliability.missedHeartbeats,
          );
          changed = true;
          expired.push({ nodeId: rec.nodeId, lastSeen: rec.lastSeen, missedHeartbeats: rec.reliability.missedHeartbeats });
            emit({ type: "node.expired", nodeId: rec.nodeId, available: false, transport: rec.transport, operation: "expiry" });
        } else {
          rec.available = false;
        }
      }
    }
    if (changed) {
      lastExpiryAt = Date.now();
      lastExpiryCount = expired.length;
      lastMutationAt = lastExpiryAt;
      persist();
    }
    return expired;
  }

  const registry: Registry = {
    version: REGISTRY_VERSION,
    heartbeatTimeoutMs,

    register(baseUrl: string, identity: Identity, capacity?: NodeCapacity): NodeRecord {
      if (!identity || typeof identity !== "object" || !Buffer.isBuffer(identity.publicKey) || !Buffer.isBuffer(identity.privateKey)) {
        throw new Error("invalid identity");
      }
      const publicKey = identity.publicKey.toString("base64");
      const timestamp = String(Date.now());
      const nonce = randomBytes(NONCE_BYTES).toString("hex");
      const payload = registrationPayload(baseUrl, capacity, timestamp, nonce);
      const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
      return registry.registerSigned(capacity ? { baseUrl, publicKey, timestamp, nonce, signature: sig, capacity } : { baseUrl, publicKey, timestamp, nonce, signature: sig });
    },

    registerSigned(signed: SignedRegistration): NodeRecord {
      try { return registry.registerSignedInternal(signed); } catch (error) {
        const nodeId = typeof signed?.publicKey === "string" ? signed.publicKey.slice(0, 96) : "unknown";
        emit({ type: "node.registration-rejected", nodeId, state: "register-rejected", operation: "register", classification: "validation" });
        throw error;
      }
    },

    registerSignedInternal(signed: SignedRegistration): NodeRecord {
      if (!signed || typeof signed !== "object") throw new Error("malformed node record");
      const { baseUrl, publicKey, timestamp, nonce, signature, capacity } = signed as unknown as Record<string, unknown>;
      if (typeof baseUrl !== "string" || typeof publicKey !== "string" || typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
        throw new Error("malformed node record");
      }
      if ("privateKey" in (signed as unknown as Record<string, unknown>) || "recoveryPhrase" in (signed as unknown as Record<string, unknown>)) {
        throw new Error("private keys never enter registry");
      }
      validateBaseUrl(baseUrl);
      const pubkeyBuf = validatePublicKey(publicKey);
      const ts = validateTimestamp(timestamp);
      const now = Date.now();
      validateNonce(nonce, now, ts);
      let cap: NodeCapacity | undefined;
      if (capacity !== undefined) {
        cap = validateCapacity(capacity);
      }
      const descriptor = signed.descriptor;
      const nodeId = descriptor?.nodeId ?? nodeIdFromPublicKey(publicKey);
      if (descriptor !== undefined) {
        validateP2PPeerDescriptor(descriptor);
        if (descriptor.baseUrl !== baseUrl || descriptor.identity.publicKey !== publicKey ||
            descriptor.identityBinding !== descriptor.nodeId || descriptor.nodeId !== peerIdFromOpenStorePublicKey(Buffer.from(publicKey, "base64"))) {
          throw new Error("libp2p descriptor identity does not match registration");
        }
        if (descriptor.capabilities.lifecycle !== undefined) validateLifecycle(descriptor.capabilities.lifecycle);
      }
      const payload = descriptor === undefined
        ? registrationPayload(baseUrl, cap, timestamp, nonce)
        : descriptorPayload("REGISTER", descriptor, cap, timestamp, nonce);
      verifySignature(pubkeyBuf, payload, signature);
      // Preserve reliability history on re-registration; new nodes get neutral default.
      const existing = nodes.get(nodeId);
      const reliability = existing
        ? { ...existing.reliability }
        : defaultReliability();
      const record: NodeRecord = {
        nodeId,
        publicKey,
        baseUrl,
        available: descriptor?.capabilities.lifecycle !== "released",
        lastSeen: Date.now(),
        capacity: cap ?? { allocatedBytes: 0, totalBytes: 0, usedBytes: 0, availableBytes: 0 },
        reliability,
        ...(descriptor === undefined ? {} : {
          transport: "libp2p" as const,
          multiaddr: descriptor.multiaddr,
          identityBinding: descriptor.identityBinding,
          capabilities: { ...descriptor.capabilities },
          ...(descriptor.capabilities.lifecycle === undefined ? {} : { lifecycle: descriptor.capabilities.lifecycle }),
        }),
      };
      nodes.set(nodeId, record);
      lastMutationAt = Date.now();
      const eventType = existing ? "node.re-registered" : "node.registered";
      if (lifecycleStates.get(nodeId) !== eventType) {
        lifecycleStates.set(nodeId, eventType);
          lastMutationAt = Date.now();
          emit({ type: eventType, nodeId, available: true, transport: record.transport, operation: "register" });
      }
      persist();
      return { ...record, capacity: { ...record.capacity }, reliability: { ...record.reliability } };
    },

    registerLibp2pSigned(signed: SignedLibp2pRegistration): NodeRecord {
      if (!signed.descriptor) throw new Error("libp2p descriptor is required");
      return registry.registerSigned(signed);
    },

    heartbeat(nodeId: string, identity: Identity, capacity?: NodeCapacity): NodeRecord {
      if (!identity || typeof identity !== "object" || !Buffer.isBuffer(identity.publicKey) || !Buffer.isBuffer(identity.privateKey)) {
        throw new Error("invalid identity");
      }
      const publicKey = identity.publicKey.toString("base64");
      const timestamp = String(Date.now());
      const nonce = randomBytes(NONCE_BYTES).toString("hex");
      const payload = heartbeatPayload(nodeId, capacity, timestamp, nonce);
      const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
      return registry.heartbeatSigned(capacity ? { nodeId, publicKey, timestamp, nonce, signature: sig, capacity } : { nodeId, publicKey, timestamp, nonce, signature: sig });
    },

    heartbeatSigned(signed: SignedHeartbeat): NodeRecord {
      try { return registry.heartbeatSignedInternal(signed); } catch (error) {
        emit({ type: "node.heartbeat-rejected", nodeId: typeof signed?.nodeId === "string" ? signed.nodeId.slice(0, 96) : "unknown", state: "heartbeat-rejected", operation: "heartbeat", classification: "validation" });
        throw error;
      }
    },

    heartbeatSignedInternal(signed: SignedHeartbeat): NodeRecord {
      if (!signed || typeof signed !== "object") throw new Error("malformed node record");
      const { nodeId, publicKey, timestamp, nonce, signature, capacity } = signed as unknown as Record<string, unknown>;
      if (typeof nodeId !== "string" || typeof publicKey !== "string" || typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
        throw new Error("malformed node record");
      }
      if ("privateKey" in (signed as unknown as Record<string, unknown>)) throw new Error("private keys never enter registry");
      const pubkeyBuf = validatePublicKey(publicKey);
      const ts = validateTimestamp(timestamp as string);
      const now = Date.now();
      validateNonce(nonce as string, now, ts);
      let cap: NodeCapacity | undefined;
      if (capacity !== undefined) {
        cap = validateCapacity(capacity);
      }
      const descriptor = signed.descriptor;
      if (descriptor !== undefined) {
        validateP2PPeerDescriptor(descriptor);
        if (descriptor.nodeId !== nodeId || descriptor.identity.publicKey !== publicKey ||
            descriptor.identityBinding !== descriptor.nodeId) {
          throw new Error("libp2p descriptor identity does not match heartbeat");
        }
        if (descriptor.capabilities.lifecycle !== undefined) validateLifecycle(descriptor.capabilities.lifecycle);
      }
      const payload = descriptor === undefined
        ? heartbeatPayload(nodeId as string, cap, timestamp as string, nonce as string)
        : descriptorPayload("HEARTBEAT", descriptor, cap, timestamp as string, nonce as string);
      verifySignature(pubkeyBuf, payload, signature as string);
      const expectedId = nodeIdFromPublicKey(publicKey as string);
      const existing = nodes.get(nodeId as string);
      if (nodeId !== expectedId && !(descriptor !== undefined &&
          nodeId === peerIdFromOpenStorePublicKey(Buffer.from(publicKey as string, "base64")))) {
        throw new Error("invalid signature: nodeId does not match publicKey");
      }
      if (!existing) throw new Error("node not found");
      existing.lastSeen = Date.now();
      lastMutationAt = existing.lastSeen;
      existing.available = descriptor?.capabilities.lifecycle !== "released";
      if (cap) existing.capacity = cap;
      if (descriptor) {
        existing.baseUrl = descriptor.baseUrl;
        existing.transport = "libp2p";
        existing.multiaddr = descriptor.multiaddr;
        existing.identityBinding = descriptor.identityBinding;
        existing.capabilities = { ...descriptor.capabilities };
        existing.lifecycle = descriptor.capabilities.lifecycle;
      }
      // Successful authenticated heartbeat improves reliability gradually & deterministically.
      existing.reliability.successfulHeartbeats += 1;
      existing.reliability.score = computeReliabilityScore(
        existing.reliability.successfulHeartbeats,
        existing.reliability.missedHeartbeats,
      );
      if (lifecycleStates.get(nodeId) !== "node.heartbeat-accepted") {
        lifecycleStates.set(nodeId, "node.heartbeat-accepted");
        lastMutationAt = Date.now();
        emit({ type: "node.heartbeat-accepted", nodeId: nodeId as string, available: true, transport: existing.transport, operation: "heartbeat" });
      }
      persist();
      return { ...existing, capacity: { ...existing.capacity }, reliability: { ...existing.reliability } };
    },

    heartbeatLibp2pSigned(signed: SignedLibp2pHeartbeat): NodeRecord {
      if (!signed.descriptor) throw new Error("libp2p descriptor is required");
      return registry.heartbeatSigned(signed);
    },

    unregister(nodeId: string, identity: Identity): void {
      if (!identity || typeof identity !== "object" || !Buffer.isBuffer(identity.publicKey) || !Buffer.isBuffer(identity.privateKey)) {
        throw new Error("invalid identity");
      }
      const publicKey = identity.publicKey.toString("base64");
      const timestamp = String(Date.now());
      const nonce = randomBytes(NONCE_BYTES).toString("hex");
      const payload = `UNREGISTER\n${nodeId}\n${timestamp}\n${nonce}`;
      const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
      registry.unregisterSigned({ nodeId, publicKey, timestamp, nonce, signature: sig });
    },

    unregisterSigned(signed: SignedUnregister): void {
      if (!signed || typeof signed !== "object") throw new Error("malformed node record");
      const { nodeId, publicKey, timestamp, nonce, signature } = signed as unknown as Record<string, unknown>;
      if (typeof nodeId !== "string" || typeof publicKey !== "string" || typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
        throw new Error("malformed node record");
      }
      if ("privateKey" in (signed as unknown as Record<string, unknown>)) throw new Error("private keys never enter registry");
      const pubkeyBuf = validatePublicKey(publicKey as string);
      const ts = validateTimestamp(timestamp as string);
      const now = Date.now();
      validateNonce(nonce as string, now, ts);
      const payload = `UNREGISTER\n${nodeId}\n${timestamp}\n${nonce}`;
      verifySignature(pubkeyBuf, payload, signature as string);
      const expectedId = nodeIdFromPublicKey(publicKey as string);
      const existing = nodes.get(nodeId as string);
      if (nodeId !== expectedId && !(existing?.transport === "libp2p" &&
          nodeId === peerIdFromOpenStorePublicKey(Buffer.from(publicKey as string, "base64")))) {
        throw new Error("invalid signature: nodeId does not match publicKey");
      }
      if (!nodes.has(nodeId as string)) throw new Error("node not found");
      nodes.delete(nodeId as string);
      lifecycleStates.delete(nodeId as string);
      lastMutationAt = Date.now();
      emit({ type: "node.unregistered", nodeId: nodeId as string, available: false, transport: existing?.transport, operation: "unregister" });
      persist();
    },

    recordStorageAudit(nodeId: string, result: StorageAuditResult): NodeRecord {
      if (typeof nodeId !== "string" || nodeId === "") throw new TypeError("nodeId must be a non-empty string");
      if (!result || typeof result !== "object") throw new TypeError("result must be an object");
      const { auditId, healthy, unhealthy } = result;
      if (typeof auditId !== "string" || auditId === "") throw new TypeError("result.auditId must be a non-empty string");
      if (!Number.isInteger(healthy) || healthy < 0) throw new TypeError("result.healthy must be a non-negative integer");
      if (!Number.isInteger(unhealthy) || unhealthy < 0) throw new TypeError("result.unhealthy must be a non-negative integer");
      const existing = nodes.get(nodeId);
      if (!existing) throw new Error("node not found");
      const dedupKey = `${auditId}:${nodeId}`;
      if (seenAuditIds.has(dedupKey)) {
        // Same audit already recorded — return current state unchanged.
        return { ...existing, capacity: { ...existing.capacity }, reliability: { ...existing.reliability } };
      }
      // Update ONLY storage-audit health; heartbeat counters/score untouched.
      existing.reliability.successfulAudits += healthy;
      existing.reliability.failedAudits += unhealthy;
      existing.reliability.storageScore = computeStorageScore(
        existing.reliability.successfulAudits,
        existing.reliability.failedAudits,
      );
      seenAuditIds.add(dedupKey);
      while (seenAuditIds.size > MAX_SEEN_AUDIT_IDS) {
        const oldest = seenAuditIds.values().next();
        if (oldest.done) break;
        seenAuditIds.delete(oldest.value as string);
      }
      persist();
      return { ...existing, capacity: { ...existing.capacity }, reliability: { ...existing.reliability } };
    },

    list(): NodeRecord[] {
      prune();
      return Array.from(nodes.values()).map((r) => ({ ...r, capacity: { ...r.capacity }, reliability: { ...r.reliability } }));
    },

    listAvailable(): NodeRecord[] {
      prune();
      return Array.from(nodes.values())
        .filter((r) => r.available)
        .map((r) => ({ ...r, capacity: { ...r.capacity }, reliability: { ...r.reliability } }));
    },

    get(nodeId: string): NodeRecord | undefined {
      prune();
      const rec = nodes.get(nodeId);
      return rec ? { ...rec, capacity: { ...rec.capacity }, reliability: { ...rec.reliability } } : undefined;
    },

    getAvailableEndpoints(): StorageNodeEndpoint[] {
      // Discovery metadata exposes heartbeat + storage health via optional scores.
      return registry.listAvailable().map((r) => ({
        id: r.nodeId,
        baseUrl: r.baseUrl,
        reliabilityScore: r.reliability.score,
        storageScore: r.reliability.storageScore,
        ...(r.transport === "libp2p" ? {
          multiaddr: r.multiaddr,
          identityBinding: r.identityBinding,
          identity: { publicKey: r.publicKey },
        } : {}),
      }));
    },

    registerDiscoveredPeer(peer: P2PPeerDescriptor, options = {}): NodeRecord {
      validateP2PPeerDescriptor(peer);
      if (peer.identityBinding === undefined || peer.identityBinding !== peer.nodeId) {
        throw new Error("discovered peer requires a valid identity binding");
      }
      const existing = nodes.get(peer.nodeId);
      for (const record of nodes.values()) {
        if (record.publicKey === peer.identity.publicKey && record.nodeId !== peer.nodeId) {
          throw new Error("discovered peer identity is already registered");
        }
      }
      const availableBytes = options.availableBytes ?? peer.capabilities.availableBytes ?? peer.capabilities.maxPieceBytes ?? 0;
      const usedBytes = options.usedBytes ?? 0;
      if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 ||
        !Number.isSafeInteger(usedBytes) || usedBytes < 0) {
        throw new TypeError("discovered peer capacity is invalid");
      }
      const reliability = existing ? { ...existing.reliability } : defaultReliability();
      if (options.reliabilityScore !== undefined) {
        if (!Number.isInteger(options.reliabilityScore) || options.reliabilityScore < 0 || options.reliabilityScore > 100) {
          throw new TypeError("discovered peer reliability score is invalid");
        }
        reliability.score = options.reliabilityScore;
      }
      const record: NodeRecord = {
        nodeId: peer.nodeId,
        publicKey: peer.identity.publicKey,
        baseUrl: peer.baseUrl,
        available: true,
        lastSeen: Date.now(),
        capacity: {
          allocatedBytes: availableBytes + usedBytes,
          totalBytes: availableBytes + usedBytes,
          usedBytes,
          availableBytes,
        },
        reliability,
        transport: "libp2p",
        multiaddr: peer.multiaddr,
        identityBinding: peer.identityBinding,
        capabilities: { ...peer.capabilities },
      };
      nodes.set(record.nodeId, record);
      persist();
      return { ...record, capacity: { ...record.capacity }, reliability: { ...record.reliability } };
    },

    removeDiscoveredPeer(nodeId: string): void {
      const record = nodes.get(nodeId);
      if (record?.transport === "libp2p") {
        nodes.delete(nodeId);
        persist();
      }
    },

    pruneExpired(): ExpiredNodeInfo[] {
      return prune();
    },
    healthSnapshot(): RegistryHealthSnapshot {
      prune();
      const records = Array.from(nodes.values());
      const totalCapacityBytes = records.reduce((sum, record) => sum + (record.capacity.allocatedBytes ?? record.capacity.totalBytes ?? 0), 0);
      const usedCapacityBytes = records.reduce((sum, record) => sum + record.capacity.usedBytes, 0);
      const availableCapacityBytes = records.reduce((sum, record) => sum + record.capacity.availableBytes, 0);
      return {
        totalNodes: records.length,
        availableNodes: records.filter((record) => record.available).length,
        unavailableNodes: records.filter((record) => !record.available).length,
        totalCapacityBytes,
        usedCapacityBytes,
        availableCapacityBytes,
        averageReliabilityScore: records.length ? Math.round(records.reduce((sum, record) => sum + record.reliability.score, 0) / records.length) : 0,
        averageStorageScore: records.length ? Math.round(records.reduce((sum, record) => sum + record.reliability.storageScore, 0) / records.length) : 0,
        heartbeatTimeoutMs,
        lastMutationAt,
        lastExpiryAt,
        lastExpiryCount,
      };
    },
    persistenceStatus(): PersistenceStatus {
      const enabled = Boolean(persistencePath);
      return { enabled, healthy: enabled ? !persistenceDegraded : true, degraded: enabled ? persistenceDegraded : false, lastLoadOutcome, lastWriteOutcome };
    },
  };

  return registry;
}

/**
 * Helper to create a signed registration payload without exposing registry internals.
 * Useful for tests that want to craft signatures manually.
 */
export function createSignedRegistration(
  identity: Identity,
  baseUrl: string,
  opts: { timestamp?: number; nonce?: string; capacity?: NodeCapacity } = {},
): SignedRegistration {
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES).toString("hex");
  const payload = registrationPayload(baseUrl, opts.capacity, timestamp, nonce);
  const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
  return opts.capacity
    ? { baseUrl, publicKey: identity.publicKey.toString("base64"), timestamp, nonce, signature: sig, capacity: opts.capacity }
    : { baseUrl, publicKey: identity.publicKey.toString("base64"), timestamp, nonce, signature: sig };
}

export function createSignedHeartbeat(
  identity: Identity,
  nodeId: string,
  opts: { timestamp?: number; nonce?: string; capacity?: NodeCapacity } = {},
): SignedHeartbeat {
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES).toString("hex");
  const payload = heartbeatPayload(nodeId, opts.capacity, timestamp, nonce);
  const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
  return opts.capacity
    ? { nodeId, publicKey: identity.publicKey.toString("base64"), timestamp, nonce, signature: sig, capacity: opts.capacity }
    : { nodeId, publicKey: identity.publicKey.toString("base64"), timestamp, nonce, signature: sig };
}

export function createSignedLibp2pRegistration(
  identity: Identity,
  descriptor: P2PRegistrationDescriptor,
  opts: { timestamp?: number; nonce?: string; capacity?: NodeCapacity } = {},
): SignedLibp2pRegistration {
  validateP2PPeerDescriptor(descriptor);
  if (descriptor.identity.publicKey !== identity.publicKey.toString("base64") ||
      descriptor.identityBinding !== descriptor.nodeId ||
      descriptor.nodeId !== peerIdFromOpenStorePublicKey(Buffer.from(descriptor.identity.publicKey, "base64"))) {
    throw new Error("libp2p descriptor identity does not match signing identity");
  }
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES).toString("hex");
  const payload = descriptorPayload("REGISTER", descriptor, opts.capacity, timestamp, nonce);
  const signature = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
  return { baseUrl: descriptor.baseUrl, publicKey: descriptor.identity.publicKey, timestamp, nonce, signature, descriptor,
    ...(opts.capacity === undefined ? {} : { capacity: opts.capacity }) };
}

export function createSignedLibp2pHeartbeat(
  identity: Identity,
  descriptor: P2PRegistrationDescriptor,
  opts: { timestamp?: number; nonce?: string; capacity?: NodeCapacity } = {},
): SignedLibp2pHeartbeat {
  validateP2PPeerDescriptor(descriptor);
  if (descriptor.identity.publicKey !== identity.publicKey.toString("base64") ||
      descriptor.identityBinding !== descriptor.nodeId ||
      descriptor.nodeId !== peerIdFromOpenStorePublicKey(Buffer.from(descriptor.identity.publicKey, "base64"))) {
    throw new Error("libp2p descriptor identity does not match signing identity");
  }
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES).toString("hex");
  const payload = descriptorPayload("HEARTBEAT", descriptor, opts.capacity, timestamp, nonce);
  const signature = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
  return { nodeId: descriptor.nodeId, publicKey: descriptor.identity.publicKey, timestamp, nonce, signature, descriptor,
    ...(opts.capacity === undefined ? {} : { capacity: opts.capacity }) };
}

export function createSignedUnregister(
  identity: Identity,
  nodeId: string,
  opts: { timestamp?: number; nonce?: string } = {},
): SignedUnregister {
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES).toString("hex");
  const payload = `UNREGISTER\n${nodeId}\n${timestamp}\n${nonce}`;
  const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
  return { nodeId, publicKey: identity.publicKey.toString("base64"), timestamp, nonce, signature: sig };
}

// Cross-process coordinator transport is optional and kept in its own module
// so the in-process registry remains usable without an HTTP server.
export {
  REGISTRY_PROTOCOL_VERSION,
  DEFAULT_REGISTRY_COORDINATOR_PORT,
  createRegistryCoordinator,
  createRegistryClient,
} from "./coordinator.js";
export type {
  RegistryCoordinator,
  RegistryCoordinatorOptions,
  RegistryClientOptions,
  RegistryClient,
} from "./coordinator.js";
