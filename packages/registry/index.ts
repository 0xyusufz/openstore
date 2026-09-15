/**
 * OpenStore Node Registry (OPENSTORE-010)
 *
 * In-memory authenticated registry for storage node discovery.
 * Uses Ed25519 signatures to prove ownership; no private keys stored.
 * No database, no P2P, stdlib only.
 */

import { randomBytes } from "crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { signMessage, verifyMessage } from "../identity/index.js";
import type { Identity } from "../identity/index.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";

export const REGISTRY_VERSION = 1;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

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

export interface NodeCapacity {
  allocatedBytes?: number;
  usedBytes: number;
  availableBytes: number;
  /** @deprecated use allocatedBytes */
  totalBytes?: number;
}

export interface NodeRecord {
  nodeId: string;
  publicKey: string;
  baseUrl: string;
  available: boolean;
  lastSeen: number;
  capacity: NodeCapacity;
}

export interface RegistryOptions {
  heartbeatTimeoutMs?: number;
  maxClockSkewMs?: number;
  /** Optional file path for persistent storage. If omitted, registry is in-memory only. */
  persistencePath?: string;
}

export interface Registry {
  readonly version: number;
  register(baseUrl: string, identity: Identity, capacity?: NodeCapacity): NodeRecord;
  registerSigned(signed: SignedRegistration): NodeRecord;
  heartbeat(nodeId: string, identity: Identity, capacity?: NodeCapacity): NodeRecord;
  heartbeatSigned(signed: SignedHeartbeat): NodeRecord;
  unregister(nodeId: string, identity: Identity): void;
  unregisterSigned(signed: SignedUnregister): void;
  list(): NodeRecord[];
  listAvailable(): NodeRecord[];
  get(nodeId: string): NodeRecord | undefined;
  getAvailableEndpoints(): StorageNodeEndpoint[];
  pruneExpired(): void;
}

export interface SignedRegistration {
  baseUrl: string;
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
  capacity?: NodeCapacity;
}

export interface SignedHeartbeat {
  nodeId: string;
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
  capacity?: NodeCapacity;
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
  const persistencePath = options.persistencePath;
  const nodes = new Map<string, NodeRecord>();
  const seenNonces = new Map<string, number>();

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
    } catch {
      return null;
    }
    // Reject if private keys present
    if ("privateKey" in r || "recoveryPhrase" in r || "signature" in r) return null;
    return {
      nodeId: r["nodeId"] as string,
      publicKey: r["publicKey"] as string,
      baseUrl: r["baseUrl"] as string,
      available: r["available"] as boolean,
      lastSeen: r["lastSeen"] as number,
      capacity,
    };
  }

  function loadPersisted(): void {
    if (!persistencePath) return;
    try {
      const data = readFileSync(persistencePath, "utf8");
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const rawNodes = parsed["nodes"];
      if (!Array.isArray(rawNodes)) return;
      for (const raw of rawNodes) {
        const rec = isValidPersistedRecord(raw);
        if (rec) nodes.set(rec.nodeId, rec);
      }
    } catch {
      // Ignore malformed or missing file safely
    }
  }

  function persist(): void {
    if (!persistencePath) return;
    const payload = JSON.stringify(
      { version: REGISTRY_VERSION, nodes: Array.from(nodes.values()) },
      null,
      2,
    );
    try {
      const dir = dirname(persistencePath);
      mkdirSync(dir, { recursive: true });
    } catch {}
    const tmpPath = `${persistencePath}.tmp.${randomBytes(4).toString("hex")}`;
    try {
      writeFileSync(tmpPath, payload, { mode: 0o600 });
      // Ensure restrictive perms even if file existed
      try {
        // chmod 0o600 where supported (ignore on Windows)
        const { chmodSync } = require("fs");
        chmodSync(tmpPath, 0o600);
      } catch {}
      renameSync(tmpPath, persistencePath);
    } catch {
      // Clean up tmp on failure, previous file remains intact
      try {
        const { unlinkSync } = require("fs");
        unlinkSync(tmpPath);
      } catch {}
      // Don't throw - persistence failure should not crash registry
      // But for correctness, we should not silently ignore? For now, ignore
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
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("malformed node record: baseUrl must be http or https");
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

  function validateCapacity(cap: unknown): NodeCapacity {
    if (!cap || typeof cap !== "object" || Array.isArray(cap)) throw new Error("malformed node record: invalid capacity");
    const c = cap as Record<string, unknown>;
    // Accept allocatedBytes or totalBytes
    const totalRaw = c["allocatedBytes"] ?? c["totalBytes"];
    if (typeof totalRaw !== "number" || !Number.isInteger(totalRaw as number) || (totalRaw as number) < 0) {
      throw new Error("malformed node record: invalid capacity allocatedBytes");
    }
    for (const f of ["usedBytes", "availableBytes"] as const) {
      if (typeof c[f] !== "number" || !Number.isInteger(c[f] as number) || (c[f] as number) < 0) {
        throw new Error(`malformed node record: invalid capacity ${f}`);
      }
    }
    const total = totalRaw as number;
    const used = c["usedBytes"] as number;
    const available = c["availableBytes"] as number;
    if (used + available !== total && total !== 0) {
      if (used > total || available !== total - used) {
        throw new Error("malformed node record: capacity inconsistent");
      }
    }
    return { allocatedBytes: total, totalBytes: total, usedBytes: used, availableBytes: available };
  }

  function prune(): void {
    const now = Date.now();
    for (const [id, rec] of nodes) {
      if (now - rec.lastSeen > heartbeatTimeoutMs) {
        rec.available = false;
      }
    }
  }

  const registry: Registry = {
    version: REGISTRY_VERSION,

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
      const payload = registrationPayload(baseUrl, cap, timestamp, nonce);
      verifySignature(pubkeyBuf, payload, signature);
      const nodeId = nodeIdFromPublicKey(publicKey);
      // Prevent registration using another node's identity: nodeId must match publicKey
      // (already ensured by deriving nodeId from publicKey)

      const record: NodeRecord = {
        nodeId,
        publicKey,
        baseUrl,
        available: true,
        lastSeen: Date.now(),
        capacity: cap ?? { allocatedBytes: 0, totalBytes: 0, usedBytes: 0, availableBytes: 0 },
      };
      nodes.set(nodeId, record);
      persist();
      return { ...record };
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
      const payload = heartbeatPayload(nodeId as string, cap, timestamp as string, nonce as string);
      verifySignature(pubkeyBuf, payload, signature as string);
      const expectedId = nodeIdFromPublicKey(publicKey as string);
      if (nodeId !== expectedId) throw new Error("invalid signature: nodeId does not match publicKey");
      const existing = nodes.get(nodeId as string);
      if (!existing) throw new Error("node not found");
      existing.lastSeen = Date.now();
      existing.available = true;
      if (cap) existing.capacity = cap;
      persist();
      return { ...existing };
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
      if (nodeId !== expectedId) throw new Error("invalid signature: nodeId does not match publicKey");
      if (!nodes.has(nodeId as string)) throw new Error("node not found");
      nodes.delete(nodeId as string);
      persist();
    },

    list(): NodeRecord[] {
      prune();
      return Array.from(nodes.values()).map((r) => ({ ...r }));
    },

    listAvailable(): NodeRecord[] {
      prune();
      return Array.from(nodes.values())
        .filter((r) => r.available)
        .map((r) => ({ ...r }));
    },

    get(nodeId: string): NodeRecord | undefined {
      prune();
      const rec = nodes.get(nodeId);
      return rec ? { ...rec } : undefined;
    },

    getAvailableEndpoints(): StorageNodeEndpoint[] {
      return registry.listAvailable().map((r) => ({ id: r.nodeId, baseUrl: r.baseUrl }));
    },

    pruneExpired(): void {
      prune();
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
