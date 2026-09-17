import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  readonly reason?: "invalid" | "stale" | "incomplete" | "identity-mismatch" | "revision-mismatch" | "untrusted" | "unavailable";
  readonly snapshot?: CoordinatorBootstrapSnapshot;
}

export interface CoordinatorReplicaBootstrapRequest {
  readonly version: 1;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
  readonly knownInstanceId?: string;
  readonly knownRevision?: number;
}

export interface CoordinatorReplicaBootstrapResponse {
  readonly version: 1;
  readonly snapshot: CoordinatorBootstrapSnapshot;
  readonly proof: CoordinatorAuthorityProof;
}

export type ReplicaBootstrapLifecycle = "uninitialized" | "bootstrapping" | "accepted" | "rejected" | "stale" | "unavailable";

export interface CoordinatorReplicaBootstrapStatus {
  readonly version: 1;
  readonly state: ReplicaBootstrapLifecycle;
  readonly authorityClassification: "non-authoritative";
  readonly sourceInstanceId?: string;
  readonly acceptedRevision?: number;
  readonly snapshotDigest?: string;
  readonly lastValidatedAt?: number;
  readonly persistenceHealthy: boolean;
}

export interface CoordinatorReplicaStateTransfer {
  request(request: CoordinatorReplicaBootstrapRequest): Promise<CoordinatorReplicaBootstrapResponse>;
  import(response: CoordinatorReplicaBootstrapResponse, transportAuthenticated: boolean, signal?: AbortSignal): Promise<BootstrapResult>;
  status(): CoordinatorReplicaBootstrapStatus;
}

const MAX_BOOTSTRAP_NODES = 10_000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function freezeSnapshot(snapshot: CoordinatorBootstrapSnapshot): CoordinatorBootstrapSnapshot {
  return Object.freeze({
    ...snapshot,
    instance: Object.freeze({ ...snapshot.instance }),
    nodes: Object.freeze(snapshot.nodes.map((node) => Object.freeze({
      ...node,
      capacity: Object.freeze({ ...node.capacity }),
      reliability: Object.freeze({ ...node.reliability }),
    }))),
  });
}

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

  export interface CoordinatorSnapshotExporter {
    request(request: CoordinatorReplicaBootstrapRequest): Promise<CoordinatorReplicaBootstrapResponse>;
  }

  export function createCoordinatorSnapshotExporter(
    snapshotProvider: () => CoordinatorBootstrapSnapshot,
    privateKey: Buffer,
    now: () => number = () => Date.now(),
  ): CoordinatorSnapshotExporter {
    return {
      async request(request): Promise<CoordinatorReplicaBootstrapResponse> {
        if (!request || request.version !== 1) throw new TypeError("bootstrap request is invalid");
        const snapshot = freezeSnapshot(snapshotProvider());
        validateBootstrapSnapshot(snapshot, now());
        if (request.maxNodes !== undefined && (!Number.isSafeInteger(request.maxNodes) || request.maxNodes < 0 || snapshot.nodes.length > request.maxNodes)) {
          throw new RangeError("bootstrap snapshot exceeds requested node bound");
        }
        const serialized = canonical(snapshot);
        if (request.maxBytes !== undefined && (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0 || Buffer.byteLength(serialized) > request.maxBytes)) {
          throw new RangeError("bootstrap snapshot exceeds requested byte bound");
        }
        if (request.knownInstanceId !== undefined && request.knownInstanceId !== snapshot.instance.instanceId) {
          throw new TypeError("bootstrap source identity does not match request");
        }
        return Object.freeze({ version: 1, snapshot, proof: createAuthorityProof(snapshot, privateKey, now()) });
      },
    };
  }

  interface PersistedReplicaState {
    readonly version: 1;
    readonly snapshot: CoordinatorBootstrapSnapshot;
    readonly proof: CoordinatorAuthorityProof;
  }

  export interface ReplicaPersistenceOptions {
    readonly persistencePath?: string;
    readonly trustedInstanceIds: readonly string[];
  }

  export class CoordinatorReplicaImporter implements CoordinatorReplicaStateTransfer {
    private lifecycle: ReplicaBootstrapLifecycle = "uninitialized";
    private acceptedSnapshot?: CoordinatorBootstrapSnapshot;
    private acceptedProof?: CoordinatorAuthorityProof;
    private lastValidatedAt?: number;
    private persistenceHealthy = true;
    private readonly trustedInstanceIds: ReadonlySet<string>;
    private readonly persistencePath?: string;

    constructor(options: ReplicaPersistenceOptions) {
      if (!Array.isArray(options.trustedInstanceIds) || options.trustedInstanceIds.length > 64) {
        throw new TypeError("trusted coordinator identities are invalid");
      }
      this.trustedInstanceIds = new Set(options.trustedInstanceIds);
      this.persistencePath = options.persistencePath;
      if (this.persistencePath) this.loadPersisted();
    }

    async request(_request: CoordinatorReplicaBootstrapRequest): Promise<CoordinatorReplicaBootstrapResponse> {
      throw new Error("replica cannot export coordinator state");
    }

    async import(response: CoordinatorReplicaBootstrapResponse, transportAuthenticated: boolean, signal?: AbortSignal): Promise<BootstrapResult> {
      this.lifecycle = "bootstrapping";
      const now = Date.now();
      try {
        if (signal?.aborted) return this.reject("unavailable");
        if (!transportAuthenticated || !response || response.version !== 1 ||
          !this.trustedInstanceIds.has(response.snapshot.instance.instanceId)) {
          return this.reject("untrusted");
        }
        validateBootstrapSnapshot(response.snapshot, now);
        const digest = coordinatorSnapshotDigest(response.snapshot);
        if (response.proof.snapshotDigest !== digest) return this.reject("invalid");
        if (!verifyAuthorityProof(response.snapshot, response.proof, now)) {
          return this.reject(response.proof.issuedAt < now ? "stale" : "invalid");
        }
        const current = this.acceptedSnapshot;
        if (current) {
          if (current.instance.instanceId !== response.snapshot.instance.instanceId) return this.reject("identity-mismatch");
          if (response.snapshot.revision < current.revision) return this.reject("revision-mismatch");
          if (response.snapshot.revision === current.revision) {
            if (coordinatorSnapshotDigest(current) !== digest) return this.reject("revision-mismatch");
            this.lastValidatedAt = now;
            return Object.freeze({ accepted: true, state: "authoritative", snapshot: current });
          }
        }
        const nextSnapshot = freezeSnapshot(response.snapshot);
        const nextProof = Object.freeze({ ...response.proof });
        this.persist({ version: 1, snapshot: nextSnapshot, proof: nextProof });
        this.acceptedSnapshot = nextSnapshot;
        this.acceptedProof = nextProof;
        this.lastValidatedAt = now;
        this.lifecycle = "accepted";
        return Object.freeze({ accepted: true, state: "authoritative", snapshot: nextSnapshot });
      } catch (error) {
        this.persistenceHealthy = false;
        this.lifecycle = "rejected";
        return Object.freeze({ accepted: false, state: "rejected", reason: error instanceof RangeError ? "incomplete" : "invalid" });
      }
    }

    status(): CoordinatorReplicaBootstrapStatus {
      return Object.freeze({
        version: 1,
        state: this.lifecycle,
        authorityClassification: "non-authoritative",
        ...(this.acceptedSnapshot ? {
          sourceInstanceId: this.acceptedSnapshot.instance.instanceId,
          acceptedRevision: this.acceptedSnapshot.revision,
          snapshotDigest: coordinatorSnapshotDigest(this.acceptedSnapshot),
        } : {}),
        ...(this.lastValidatedAt === undefined ? {} : { lastValidatedAt: this.lastValidatedAt }),
        persistenceHealthy: this.persistenceHealthy,
      });
    }

    private reject(reason: BootstrapResult["reason"]): BootstrapResult {
      this.lifecycle = reason === "stale" ? "stale" : "rejected";
      return Object.freeze({ accepted: false, state: "rejected", reason });
    }

    private persist(value: PersistedReplicaState): void {
      if (!this.persistencePath) return;
      const path = this.persistencePath;
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      const payload = canonical(value);
      writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600 });
      const fd = openSync(temp, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      try {
        const directoryFd = openSync(dir, "r");
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      } catch { /* directory fsync is not available on every platform */ }
    }

    private loadPersisted(): void {
      try {
        const raw = requirePersistedFile(this.persistencePath as string);
        if (Buffer.byteLength(raw, "utf8") > MAX_SNAPSHOT_BYTES + 4096) throw new RangeError("persisted replica state is too large");
        const value = JSON.parse(raw) as PersistedReplicaState;
        if (value.version !== 1) throw new TypeError("persisted replica state version is invalid");
        validateBootstrapSnapshot(value.snapshot, Date.now());
        if (!this.trustedInstanceIds.has(value.snapshot.instance.instanceId) ||
          !verifyAuthorityProof(value.snapshot, value.proof)) throw new TypeError("persisted replica state is not trusted");
        this.acceptedSnapshot = freezeSnapshot(value.snapshot);
        this.acceptedProof = Object.freeze({ ...value.proof });
        this.lifecycle = "accepted";
      } catch {
        this.persistenceHealthy = false;
        this.lifecycle = "unavailable";
      }
    }
  }

  function requirePersistedFile(path: string): string {
    return readFileSync(path, "utf8");
  }
