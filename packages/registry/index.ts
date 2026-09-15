/**
 * OpenStore Node Registry (OPENSTORE-010)
 *
 * In-memory authenticated registry for storage node discovery.
 * Uses Ed25519 signatures to prove ownership; no private keys stored.
 * No database, no P2P, stdlib only.
 */

import { randomBytes } from "crypto";
import { signMessage, verifyMessage } from "../identity/index.js";
import type { Identity } from "../identity/index.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";

export const REGISTRY_VERSION = 1;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const NONCE_BYTES = 16;

export interface NodeRecord {
  nodeId: string;
  publicKey: string;
  baseUrl: string;
  available: boolean;
  lastSeen: number;
}

export interface RegistryOptions {
  heartbeatTimeoutMs?: number;
  maxClockSkewMs?: number;
}

export interface Registry {
  readonly version: number;
  register(baseUrl: string, identity: Identity): NodeRecord;
  registerSigned(signed: SignedRegistration): NodeRecord;
  heartbeat(nodeId: string, identity: Identity): NodeRecord;
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
}

export interface SignedHeartbeat {
  nodeId: string;
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
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
  const nodes = new Map<string, NodeRecord>();
  const seenNonces = new Map<string, number>();

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

    register(baseUrl: string, identity: Identity): NodeRecord {
      if (!identity || typeof identity !== "object" || !Buffer.isBuffer(identity.publicKey) || !Buffer.isBuffer(identity.privateKey)) {
        throw new Error("invalid identity");
      }
      const publicKey = identity.publicKey.toString("base64");
      const timestamp = String(Date.now());
      const nonce = randomBytes(NONCE_BYTES).toString("hex");
      const payload = `REGISTER\n${baseUrl}\n${timestamp}\n${nonce}`;
      const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
      return registry.registerSigned({ baseUrl, publicKey, timestamp, nonce, signature: sig });
    },

    registerSigned(signed: SignedRegistration): NodeRecord {
      if (!signed || typeof signed !== "object") throw new Error("malformed node record");
      const { baseUrl, publicKey, timestamp, nonce, signature } = signed as unknown as Record<string, unknown>;
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
      const payload = `REGISTER\n${baseUrl}\n${timestamp}\n${nonce}`;
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
      };
      nodes.set(nodeId, record);
      return { ...record };
    },

    heartbeat(nodeId: string, identity: Identity): NodeRecord {
      if (!identity || typeof identity !== "object" || !Buffer.isBuffer(identity.publicKey) || !Buffer.isBuffer(identity.privateKey)) {
        throw new Error("invalid identity");
      }
      const publicKey = identity.publicKey.toString("base64");
      const timestamp = String(Date.now());
      const nonce = randomBytes(NONCE_BYTES).toString("hex");
      const payload = `HEARTBEAT\n${nodeId}\n${timestamp}\n${nonce}`;
      const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
      return registry.heartbeatSigned({ nodeId, publicKey, timestamp, nonce, signature: sig });
    },

    heartbeatSigned(signed: SignedHeartbeat): NodeRecord {
      if (!signed || typeof signed !== "object") throw new Error("malformed node record");
      const { nodeId, publicKey, timestamp, nonce, signature } = signed as unknown as Record<string, unknown>;
      if (typeof nodeId !== "string" || typeof publicKey !== "string" || typeof timestamp !== "string" || typeof nonce !== "string" || typeof signature !== "string") {
        throw new Error("malformed node record");
      }
      if ("privateKey" in (signed as unknown as Record<string, unknown>)) throw new Error("private keys never enter registry");
      const pubkeyBuf = validatePublicKey(publicKey);
      const ts = validateTimestamp(timestamp as string);
      const now = Date.now();
      validateNonce(nonce as string, now, ts);
      const payload = `HEARTBEAT\n${nodeId}\n${timestamp}\n${nonce}`;
      verifySignature(pubkeyBuf, payload, signature as string);
      const expectedId = nodeIdFromPublicKey(publicKey as string);
      if (nodeId !== expectedId) throw new Error("invalid signature: nodeId does not match publicKey");
      const existing = nodes.get(nodeId as string);
      if (!existing) throw new Error("node not found");
      existing.lastSeen = Date.now();
      existing.available = true;
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
  opts: { timestamp?: number; nonce?: string } = {},
): SignedRegistration {
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES).toString("hex");
  const payload = `REGISTER\n${baseUrl}\n${timestamp}\n${nonce}`;
  const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
  return { baseUrl, publicKey: identity.publicKey.toString("base64"), timestamp, nonce, signature: sig };
}

export function createSignedHeartbeat(
  identity: Identity,
  nodeId: string,
  opts: { timestamp?: number; nonce?: string } = {},
): SignedHeartbeat {
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES).toString("hex");
  const payload = `HEARTBEAT\n${nodeId}\n${timestamp}\n${nonce}`;
  const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8")).toString("base64");
  return { nodeId, publicKey: identity.publicKey.toString("base64"), timestamp, nonce, signature: sig };
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
