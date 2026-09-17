import { createHash } from "node:crypto";
import { signMessage, verifyMessage } from "../identity/index.js";

/**
 * Stable coordinator HA foundation contracts.
 *
 * This module describes the boundary a future replicated coordinator may
 * implement. It deliberately contains no election, quorum, or replication
 * mechanism.
 */

export interface CoordinatorRegistrationRequest {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly capacity?: Readonly<{ allocatedBytes: number; usedBytes: number; availableBytes: number }>;
}

export interface CoordinatorHeartbeatRequest {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly capacity?: Readonly<{ allocatedBytes: number; usedBytes: number; availableBytes: number }>;
}

export interface CoordinatorNodeSnapshot {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly available: boolean;
  readonly lastSeen: number;
  readonly capacity: Readonly<{ allocatedBytes: number; usedBytes: number; availableBytes: number }>;
}

export interface CoordinatorPersistenceSnapshot {
  readonly enabled: boolean;
  readonly healthy: boolean;
  readonly degraded: boolean;
}

export interface CoordinatorHealthSnapshot {
  readonly status: "ready" | "not-ready" | "degraded" | "unavailable";
  readonly persistence: CoordinatorPersistenceSnapshot;
  readonly nodeCount: number;
  readonly availableNodeCount: number;
}

export interface CoordinatorService {
  register(request: CoordinatorRegistrationRequest): Promise<CoordinatorNodeSnapshot>;
  heartbeat(request: CoordinatorHeartbeatRequest): Promise<CoordinatorNodeSnapshot>;
  unregister(nodeId: string, publicKey: string): Promise<void>;
  discover(): Promise<readonly CoordinatorNodeSnapshot[]>;
  persistenceStatus(): Promise<CoordinatorPersistenceSnapshot>;
  health(): Promise<CoordinatorHealthSnapshot>;
  stateSnapshot(): Promise<CoordinatorStateSnapshot>;
}

export type CoordinatorStateKind = "known" | "stale" | "unknown";

export interface CoordinatorStateSnapshot {
  readonly version: 1;
  readonly instanceId: string;
  readonly revision: number;
  readonly observedAt: number;
  readonly state: CoordinatorStateKind;
  readonly authoritative: boolean;
}

export interface CoordinatorInstanceIdentity {
  readonly version: 1;
  readonly instanceId: string;
  readonly publicKey: string;
}

export interface CoordinatorAuthoritativeNode {
  readonly nodeId: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly available: boolean;
  readonly lastSeen: number;
  readonly capacity: Readonly<{ allocatedBytes: number; usedBytes: number; availableBytes: number }>;
  readonly reliability: Readonly<Record<string, number>>;
  readonly transport?: "http" | "libp2p";
  readonly multiaddr?: string;
  readonly identityBinding?: string;
}

export interface CoordinatorBootstrapSnapshot {
  readonly version: 1;
  readonly instance: CoordinatorInstanceIdentity;
  readonly revision: number;
  readonly observedAt: number;
  readonly nodes: readonly CoordinatorAuthoritativeNode[];
}

export interface CoordinatorAuthorityProof {
  readonly version: 1;
  readonly instanceId: string;
  readonly publicKey: string;
  readonly revision: number;
  readonly snapshotDigest: string;
  readonly classification: "authoritative";
  readonly issuedAt: number;
  readonly signature: string;
}

export type BootstrapState = "uninitialized" | "bootstrapping" | "authoritative" | "stale" | "rejected" | "unavailable";

export interface BootstrapResult {
  readonly accepted: boolean;
  readonly state: BootstrapState;
  readonly reason?: "invalid" | "stale" | "incomplete" | "identity-mismatch" | "revision-mismatch" | "untrusted";
  readonly snapshot?: CoordinatorBootstrapSnapshot;
}

const MAX_BOOTSTRAP_NODES = 10_000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function createCoordinatorInstanceIdentity(publicKey: Buffer): CoordinatorInstanceIdentity {
  if (publicKey.length !== 44) throw new TypeError("coordinator public key is invalid");
  return Object.freeze({
    version: 1,
    instanceId: `coord-${createHash("sha256").update(publicKey).digest("hex").slice(0, 32)}`,
    publicKey: publicKey.toString("base64"),
  });
}

export function serializeCoordinatorInstanceIdentity(identity: CoordinatorInstanceIdentity): string {
  if (identity.version !== 1 || !INSTANCE_ID.test(identity.instanceId) || !BASE64.test(identity.publicKey) ||
    Buffer.from(identity.publicKey, "base64").length !== 44) throw new TypeError("coordinator instance identity is invalid");
  return canonical(identity);
}

export function parseCoordinatorInstanceIdentity(serialized: string): CoordinatorInstanceIdentity {
  if (typeof serialized !== "string" || serialized.length > 512) throw new TypeError("coordinator instance identity is invalid");
  const value = JSON.parse(serialized) as CoordinatorInstanceIdentity;
  if (serializeCoordinatorInstanceIdentity(value) !== serialized) throw new TypeError("coordinator instance identity is not canonical");
  return Object.freeze({ version: 1, instanceId: value.instanceId, publicKey: value.publicKey });
}

export interface CoordinatorStateOptions {
  readonly maxClockSkewMs?: number;
}

const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000;
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function assertTimestamp(value: number, now: number, maxClockSkewMs: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > now + maxClockSkewMs) {
    throw new TypeError("coordinator state timestamp is invalid");
  }
}

function assertOptions(options: CoordinatorStateOptions): number {
  const skew = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(skew) || skew < 0) throw new TypeError("maxClockSkewMs must be a non-negative safe integer");
  return skew;
}

export function createCoordinatorStateSnapshot(
  input: Omit<CoordinatorStateSnapshot, "version">,
  now = Date.now(),
  options: CoordinatorStateOptions = {},
): CoordinatorStateSnapshot {
  const skew = assertOptions(options);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative safe integer");
  if (!INSTANCE_ID.test(input.instanceId)) throw new TypeError("coordinator instanceId is invalid");
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new TypeError("coordinator revision is invalid");
  if (!["known", "stale", "unknown"].includes(input.state)) throw new TypeError("coordinator state is invalid");
  if (typeof input.authoritative !== "boolean") throw new TypeError("coordinator authority is invalid");
  assertTimestamp(input.observedAt, now, skew);
  if (input.state !== "known" && input.authoritative) {
    throw new TypeError("stale or unknown coordinator state cannot be authoritative");
  }
  return Object.freeze({ version: 1, ...input });
}

export function nextCoordinatorRevision(previous: number): number {
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("coordinator revision is invalid or exhausted");
  }
  return previous + 1;
}

export function classifyCoordinatorState(
  snapshot: CoordinatorStateSnapshot | undefined,
  now = Date.now(),
  maxAgeMs = 30_000,
): "fresh-authoritative" | "stale" | "unknown" | "ambiguous" {
  if (snapshot === undefined) return "unknown";
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
    throw new TypeError("coordinator state classification bounds are invalid");
  }

  if (snapshot.state === "unknown") return "unknown";
  if (snapshot.state === "stale" || now - snapshot.observedAt > maxAgeMs) return "stale";
  if (!snapshot.authoritative) return "ambiguous";
  return "fresh-authoritative";
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  export function coordinatorSnapshotDigest(snapshot: CoordinatorBootstrapSnapshot): string {
    const serialized = canonical(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) throw new RangeError("coordinator snapshot exceeds maximum size");
    return createHash("sha256").update(serialized).digest("hex");
  }

  export function createAuthorityProof(
    snapshot: CoordinatorBootstrapSnapshot,
    privateKey: Buffer,
    issuedAt = Date.now(),
  ): CoordinatorAuthorityProof {
    validateBootstrapSnapshot(snapshot, issuedAt);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > Date.now() + DEFAULT_MAX_CLOCK_SKEW_MS) {
      throw new TypeError("authority proof timestamp is invalid");
    }
    const payload = canonical({
      version: 1, instanceId: snapshot.instance.instanceId, publicKey: snapshot.instance.publicKey,
      revision: snapshot.revision, snapshotDigest: coordinatorSnapshotDigest(snapshot),
      classification: "authoritative", issuedAt,
    });
    return Object.freeze({
      version: 1,
      instanceId: snapshot.instance.instanceId,
      publicKey: snapshot.instance.publicKey,
      revision: snapshot.revision,
      snapshotDigest: coordinatorSnapshotDigest(snapshot),
      classification: "authoritative",
      issuedAt,
      signature: signMessage(privateKey, Buffer.from(payload)).toString("base64"),
    });
  }

  export function verifyAuthorityProof(
    snapshot: CoordinatorBootstrapSnapshot,
    proof: CoordinatorAuthorityProof,
    now = Date.now(),
    maxAgeMs = 30_000,
  ): boolean {
    try {
      validateBootstrapSnapshot(snapshot, now);
      if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || !Number.isSafeInteger(now) || now < 0) return false;
      if (proof.version !== 1 || proof.classification !== "authoritative" ||
        proof.instanceId !== snapshot.instance.instanceId || proof.publicKey !== snapshot.instance.publicKey ||
        proof.revision !== snapshot.revision || proof.snapshotDigest !== coordinatorSnapshotDigest(snapshot) ||
        !Number.isSafeInteger(proof.issuedAt) || proof.issuedAt < 0 ||
        proof.issuedAt > now + DEFAULT_MAX_CLOCK_SKEW_MS || now - proof.issuedAt > maxAgeMs ||
        now - snapshot.observedAt > maxAgeMs ||
        !BASE64.test(proof.signature)) return false;
      const payload = canonical({
        version: 1, instanceId: proof.instanceId, publicKey: proof.publicKey,
        revision: proof.revision, snapshotDigest: proof.snapshotDigest,
        classification: proof.classification, issuedAt: proof.issuedAt,
      });
      const publicKey = Buffer.from(proof.publicKey, "base64");
      return publicKey.length === 44 && verifyMessage(publicKey, Buffer.from(payload), Buffer.from(proof.signature, "base64"));
    } catch {
      return false;
    }
  }

  export function validateBootstrapSnapshot(snapshot: CoordinatorBootstrapSnapshot, now = Date.now()): void {
    if (!snapshot || snapshot.version !== 1 || !snapshot.instance || snapshot.instance.version !== 1 ||
      !INSTANCE_ID.test(snapshot.instance.instanceId) || !BASE64.test(snapshot.instance.publicKey) ||
      Buffer.from(snapshot.instance.publicKey, "base64").length !== 44 ||
      !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      !Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt < 0 ||
      snapshot.observedAt > now + DEFAULT_MAX_CLOCK_SKEW_MS ||
      !Array.isArray(snapshot.nodes) || snapshot.nodes.length > MAX_BOOTSTRAP_NODES) {
      throw new TypeError("coordinator bootstrap snapshot is invalid or incomplete");
    }
    const seen = new Set<string>();
    for (const node of snapshot.nodes) {
      if (!node || typeof node.nodeId !== "string" || node.nodeId.length === 0 || node.nodeId.length > 512 || seen.has(node.nodeId) ||
        !BASE64.test(node.publicKey) || Buffer.from(node.publicKey, "base64").length !== 44 ||
        typeof node.endpoint !== "string" || node.endpoint.length > 2048 ||
        typeof node.available !== "boolean" || !Number.isSafeInteger(node.lastSeen) || node.lastSeen < 0 ||
        node.lastSeen > now + DEFAULT_MAX_CLOCK_SKEW_MS || !node.capacity ||
        !Number.isSafeInteger(node.capacity.allocatedBytes) || node.capacity.allocatedBytes < 0 ||
        !Number.isSafeInteger(node.capacity.usedBytes) || node.capacity.usedBytes < 0 ||
        !Number.isSafeInteger(node.capacity.availableBytes) || node.capacity.availableBytes < 0 ||
        !node.reliability || Object.keys(node.reliability).length > 16 ||
        Object.values(node.reliability as Record<string, number>).some((value) => !Number.isSafeInteger(value) || value < 0) ||
        (node.identityBinding !== undefined && node.identityBinding !== node.nodeId) ||
        (node.transport !== undefined && node.transport !== "http" && node.transport !== "libp2p") ||
        (node.multiaddr !== undefined && (typeof node.multiaddr !== "string" || node.multiaddr.length > 2048))) {
        throw new TypeError("coordinator bootstrap snapshot contains invalid node state");
      }
      seen.add(node.nodeId);
    }
    if (Buffer.byteLength(canonical(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) throw new RangeError("coordinator snapshot exceeds maximum size");
  }

  export class CoordinatorBootstrapMachine {
    private currentState: BootstrapState = "uninitialized";
    private current?: CoordinatorBootstrapSnapshot;
    get state(): BootstrapState { return this.currentState; }
    get snapshot(): CoordinatorBootstrapSnapshot | undefined { return this.current; }
    begin(): void {
      if (this.currentState === "authoritative") return;
      this.currentState = "bootstrapping";
    }
    accept(snapshot: CoordinatorBootstrapSnapshot, proof: CoordinatorAuthorityProof, trustedInstanceId: string, now = Date.now()): BootstrapResult {
      this.begin();
      try {
        if (snapshot.instance.instanceId !== trustedInstanceId || proof.instanceId !== trustedInstanceId) return this.reject("identity-mismatch");
        if (!verifyAuthorityProof(snapshot, proof, now)) return this.reject(proof.issuedAt < now ? "stale" : "invalid");
        if (this.current && snapshot.revision < this.current.revision) return this.reject("revision-mismatch");
        this.current = Object.freeze(snapshot);
        this.currentState = "authoritative";
        return Object.freeze({ accepted: true, state: "authoritative", snapshot });
      } catch {
        return this.reject("incomplete");
      }
    }
    reject(reason: BootstrapResult["reason"] = "invalid"): BootstrapResult {
      this.currentState = "rejected";
      return Object.freeze({ accepted: false, state: "rejected", reason });
    }
    markUnavailable(): void { if (this.currentState !== "authoritative") this.currentState = "unavailable"; }
  }
