import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { signMessage, verifyMessage } from "../identity/index.js";
import type { MetricsRegistry } from "../metrics/index.js";
import type { EventStore } from "../events/index.js";

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

export type BootstrapState = "uninitialized" | "bootstrapping" | "authoritative" | "synchronized" | "stale" | "conflicted" | "rejected" | "unavailable";
export type ReplicaConflictReason =
  | "duplicate" | "stale_revision" | "revision_digest_conflict" | "unknown_instance"
  | "instance_conflict" | "invalid_proof" | "invalid_snapshot" | "stale_proof"
  | "future_proof" | "authority_ambiguous" | "persistence_failure";

export interface BootstrapResult {
  readonly accepted: boolean;
  readonly state: BootstrapState;
  readonly reason?: ReplicaConflictReason | "invalid" | "stale" | "incomplete" | "identity-mismatch" | "revision-mismatch" | "untrusted" | "unavailable";
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

export type ReplicaBootstrapLifecycle = "uninitialized" | "bootstrapping" | "synchronized" | "rejected" | "stale" | "conflicted" | "unavailable";

export interface CoordinatorReplicaBootstrapStatus {
  readonly version: 1;
  readonly state: ReplicaBootstrapLifecycle;
  readonly authorityClassification: "non-authoritative";
  readonly sourceInstanceId?: string;
  readonly acceptedRevision?: number;
  readonly snapshotDigest?: string;
  readonly lastValidatedAt?: number;
  readonly lastSuccessfulImportAt?: number;
  readonly lastRejectedImportAt?: number;
  readonly lastConflictReason?: ReplicaConflictReason;
  readonly persistenceHealthy: boolean;
}

export interface CoordinatorReplicaStateTransfer {
  request(request: CoordinatorReplicaBootstrapRequest): Promise<CoordinatorReplicaBootstrapResponse>;
  import(response: CoordinatorReplicaBootstrapResponse, transportAuthenticated: boolean, signal?: AbortSignal): Promise<BootstrapResult>;
  resetForRebootstrap(): Promise<void>;
  status(): CoordinatorReplicaBootstrapStatus;
}

export interface CoordinatorReplicaSyncSource {
  request(request: CoordinatorReplicaBootstrapRequest, signal?: AbortSignal): Promise<CoordinatorReplicaBootstrapResponse>;
}

export type ReplicaSyncState = "stopped" | "bootstrapping" | "synchronized" | "stale" | "conflicted" | "unavailable" | "rejected" | "retry_wait";

export interface CoordinatorReplicaSyncStatus {
  readonly version: 1;
  readonly state: ReplicaSyncState;
  readonly authorityClassification: "non-authoritative";
  readonly sourceInstanceId?: string;
  readonly acceptedRevision?: number;
  readonly snapshotDigest?: string;
  readonly lastSuccessfulSync?: number;
  readonly lastAttemptedSync?: number;
  readonly lastFailure?: string;
  readonly retryCount: number;
  readonly nextRetryAt?: number;
  readonly synchronizationAgeMs?: number;
  readonly persistenceHealthy: boolean;
  readonly conflictReason?: ReplicaConflictReason;
  readonly bootstrapStatus: "ready" | "required" | "failed";
}

export interface CoordinatorReplicaSyncOptions {
  readonly freshnessMs?: number;
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly request?: CoordinatorReplicaBootstrapRequest;
  readonly clock?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly metrics?: MetricsRegistry;
  readonly events?: EventStore;
}

export interface CoordinatorReplicaSyncManager {
  start(): Promise<void>;
  stop(): void;
  syncNow(): Promise<BootstrapResult | undefined>;
  resetForRebootstrap(): Promise<void>;
  forceSync(): Promise<BootstrapResult | undefined>;
  clearConflict(): Promise<void>;
  inspectStatus(): CoordinatorReplicaSyncStatus;
  status(): CoordinatorReplicaSyncStatus;
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

  export interface CoordinatorStateOrdering {
    readonly instanceId: string;
    readonly revision: number;
    readonly snapshotDigest: string;
  }

  export type CoordinatorOrderingResult = "duplicate" | "stale_revision" | "revision_digest_conflict" | "higher_revision" | "instance_conflict";

  export function compareCoordinatorStateOrdering(
    current: CoordinatorStateOrdering | undefined,
    candidate: CoordinatorStateOrdering,
  ): CoordinatorOrderingResult {
    if (!current) return "higher_revision";
    if (current.instanceId !== candidate.instanceId) return "instance_conflict";
    if (candidate.revision < current.revision) return "stale_revision";
    if (candidate.revision > current.revision) return "higher_revision";
    return current.snapshotDigest === candidate.snapshotDigest ? "duplicate" : "revision_digest_conflict";
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
    private lastSuccessfulImportAt?: number;
    private lastRejectedImportAt?: number;
    private lastConflictReason?: ReplicaConflictReason;
    private persistenceHealthy = true;
    private readonly trustedInstanceIds: ReadonlySet<string>;
    private readonly persistencePath?: string;

    constructor(options: ReplicaPersistenceOptions) {
      if (!Array.isArray(options.trustedInstanceIds) || options.trustedInstanceIds.length > 64) {
        throw new TypeError("trusted coordinator identities are invalid");
      }
      this.trustedInstanceIds = new Set(options.trustedInstanceIds);
      if (this.trustedInstanceIds.size !== 1) throw new TypeError("exactly one trusted coordinator identity is required");
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
          return this.reject("unknown_instance");
        }
        validateBootstrapSnapshot(response.snapshot, now);
        const digest = coordinatorSnapshotDigest(response.snapshot);
        if (response.proof.snapshotDigest !== digest) return this.reject("invalid_proof");
        if (!verifyAuthorityProof(response.snapshot, response.proof, now)) {
          return this.reject(response.proof.issuedAt > now ? "future_proof" : (now - response.proof.issuedAt > 30_000 ? "stale_proof" : "invalid_proof"));
        }
        const current = this.acceptedSnapshot;
        const ordering = compareCoordinatorStateOrdering(
          current && { instanceId: current.instance.instanceId, revision: current.revision, snapshotDigest: coordinatorSnapshotDigest(current) },
          { instanceId: response.snapshot.instance.instanceId, revision: response.snapshot.revision, snapshotDigest: digest },
        );
        if (ordering === "instance_conflict") return this.reject("instance_conflict");
        if (ordering === "stale_revision") return this.reject("stale_revision");
        if (ordering === "revision_digest_conflict") return this.reject("revision_digest_conflict");
        if (ordering === "duplicate") {
          this.lastValidatedAt = now;
          this.lastSuccessfulImportAt = now;
          this.lifecycle = "synchronized";
          return Object.freeze({ accepted: true, state: "synchronized", snapshot: current });
        }
        const nextSnapshot = freezeSnapshot(response.snapshot);
        const nextProof = Object.freeze({ ...response.proof });
        this.persist({ version: 1, snapshot: nextSnapshot, proof: nextProof });
        this.acceptedSnapshot = nextSnapshot;
        this.acceptedProof = nextProof;
        this.lastValidatedAt = now;
        this.lifecycle = "synchronized";
        this.lastSuccessfulImportAt = now;
        return Object.freeze({ accepted: true, state: "synchronized", snapshot: nextSnapshot });
      } catch (error) {
        if (error instanceof Error && error.message === "persistence failure") {
          this.persistenceHealthy = false;
          return this.reject("persistence_failure");
        }
        return this.reject(error instanceof RangeError ? "invalid_snapshot" : "invalid_snapshot");
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
        ...(this.lastSuccessfulImportAt === undefined ? {} : { lastSuccessfulImportAt: this.lastSuccessfulImportAt }),
        ...(this.lastRejectedImportAt === undefined ? {} : { lastRejectedImportAt: this.lastRejectedImportAt }),
        ...(this.lastConflictReason === undefined ? {} : { lastConflictReason: this.lastConflictReason }),
        persistenceHealthy: this.persistenceHealthy,
      });
    }

    private reject(reason: BootstrapResult["reason"]): BootstrapResult {
      this.lastRejectedImportAt = Date.now();
      if (reason === "revision_digest_conflict" || reason === "instance_conflict" || reason === "authority_ambiguous") {
        this.lifecycle = "conflicted";
        this.lastConflictReason = reason;
      } else {
        this.lifecycle = reason === "stale_proof" || reason === "stale_revision" ? "stale" : "rejected";
      }

      return Object.freeze({ accepted: false, state: this.lifecycle === "conflicted" ? "conflicted" : "rejected", reason });
    }

    async resetForRebootstrap(): Promise<void> {
      this.acceptedSnapshot = undefined;
      this.acceptedProof = undefined;
      this.lastValidatedAt = undefined;
      this.lastSuccessfulImportAt = undefined;
      this.lastRejectedImportAt = undefined;
      this.lastConflictReason = undefined;
      this.persistenceHealthy = true;
      this.lifecycle = "uninitialized";
      if (this.persistencePath) {
        try { unlinkSync(this.persistencePath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            this.persistenceHealthy = false;
            this.lifecycle = "unavailable";
            throw new Error("persistence failure");
          }
        }
      }
    }

    private persist(value: PersistedReplicaState): void {
      if (!this.persistencePath) return;
      const path = this.persistencePath;
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.tmp`;
      const payload = canonical(value);
        try {
          writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600 });
          const fd = openSync(temp, "r");
          try { fsyncSync(fd); } finally { closeSync(fd); }
          renameSync(temp, path);
          try {
            const directoryFd = openSync(dir, "r");
            try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
          } catch { /* directory fsync is not available on every platform */ }
        } catch {
          try { unlinkSync(temp); } catch { /* best effort cleanup */ }
          throw new Error("persistence failure");
        }
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
        this.lifecycle = "synchronized";
        this.lastSuccessfulImportAt = Date.now();
      } catch {
        this.persistenceHealthy = false;
        this.lifecycle = "unavailable";
      }
    }
  }

  function requirePersistedFile(path: string): string {
    return readFileSync(path, "utf8");
  }

  const DEFAULT_SYNC_FRESHNESS_MS = 30_000;
  const DEFAULT_SYNC_MAX_ATTEMPTS = 4;
  const DEFAULT_SYNC_INITIAL_DELAY_MS = 250;
  const DEFAULT_SYNC_MAX_DELAY_MS = 10_000;

  export function createCoordinatorReplicaSyncManager(
    source: CoordinatorReplicaSyncSource,
    transfer: CoordinatorReplicaStateTransfer,
    options: CoordinatorReplicaSyncOptions = {},
  ): CoordinatorReplicaSyncManager {
    const clock = options.clock ?? (() => Date.now());
    const schedule = options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    const cancel = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
    const freshnessMs = options.freshnessMs ?? DEFAULT_SYNC_FRESHNESS_MS;
    const maxAttempts = options.maxAttempts ?? DEFAULT_SYNC_MAX_ATTEMPTS;
    const initialDelayMs = options.initialDelayMs ?? DEFAULT_SYNC_INITIAL_DELAY_MS;
    const maxDelayMs = options.maxDelayMs ?? DEFAULT_SYNC_MAX_DELAY_MS;
    if (![freshnessMs, maxAttempts, initialDelayMs, maxDelayMs].every(Number.isSafeInteger) ||
        freshnessMs <= 0 || maxAttempts <= 0 || initialDelayMs < 0 || maxDelayMs < initialDelayMs) {
      throw new TypeError("replica synchronization bounds are invalid");
    }
    let state: ReplicaSyncState = "stopped";
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let active: Promise<BootstrapResult | undefined> | undefined;
    let controller: AbortController | undefined;
    let retryCount = 0;
    let lastAttemptedSync: number | undefined;
    let lastSuccessfulSync: number | undefined;
    let lastFailure: string | undefined;
    let nextRetryAt: number | undefined;
    let stopped = true;
    let staleReported = false;

    const metric = (name: string, value = 1, labels: Record<string, string> = {}): void => {
      try { options.metrics?.increment(name, value, labels); } catch { /* observability cannot alter sync safety */ }
    };
    const observe = (name: string, value: number): void => {
      try { options.metrics?.observe(name, value); } catch { /* observability cannot alter sync safety */ }
    };
    const event = (type: Parameters<EventStore["append"]>[0]["type"], severity: "info" | "warning" | "error", details: Record<string, string | number | boolean> = {}): void => {
      try { options.events?.append({ version: 1, timestamp: clock(), component: "coordinator", type, severity, details }); } catch { /* diagnostics cannot alter sync safety */ }
    };
    const safeFailure = (reason: string): string => {
      if (!/^[a-z][a-z0-9_.-]{0,31}$/.test(reason)) return "error";
      return reason;
    };
    const clearScheduled = (): void => {
      if (timer !== undefined) { cancel(timer); timer = undefined; }
      nextRetryAt = undefined;
    };
    const scheduleRetry = (): void => {
      if (stopped) return;
      if (retryCount >= maxAttempts) { state = "unavailable"; return; }
      state = "retry_wait";
      const delay = Math.min(maxDelayMs, initialDelayMs * (2 ** Math.max(0, retryCount - 1)));
      nextRetryAt = clock() + delay;
      timer = schedule(() => {
        timer = undefined;
        void syncNow();
      }, delay);
      metric("coordinator_replica_sync_retry_total");
      event("replica.sync.retry", "warning", { retryCount });
    };
    const run = async (): Promise<BootstrapResult | undefined> => {
      if (stopped) return undefined;
      state = "bootstrapping";
      event("replica.sync.started", "info");
      metric("coordinator_replica_sync_attempt_total");
      lastAttemptedSync = clock();
      const started = lastAttemptedSync;
      controller = new AbortController();
      try {
        const response = await source.request({ version: 1, ...(options.request ?? {}) }, controller.signal);
        if (controller.signal.aborted || stopped) return undefined;
        const result = await transfer.import(response, true, controller.signal);
        if (result.accepted) {
          state = "synchronized";
          lastSuccessfulSync = clock();
          retryCount = 0;
          staleReported = false;
          lastFailure = undefined;
          nextRetryAt = undefined;
          metric("coordinator_replica_sync_success_total");
          event("replica.sync.succeeded", "info");
        } else {
          const reason = safeFailure(String(result.reason ?? "rejected"));
          lastFailure = reason;
          state = result.state === "conflicted" ? "conflicted" :
            result.reason === "unavailable" || result.reason === "persistence_failure" ? "unavailable" : "rejected";
          metric("coordinator_replica_sync_failure_total", 1, { result: "rejected" });
          if (result.state === "conflicted") metric("coordinator_replica_conflict_total");
          event(result.state === "conflicted" ? "replica.conflict.detected" : "replica.sync.failed", "error", { reason });
          if (state === "unavailable") { retryCount += 1; scheduleRetry(); }
        }
        observe("coordinator_replica_sync_duration_ms", Math.max(0, clock() - started));
        return result;
      } catch {
        lastFailure = "unavailable";
        state = "unavailable";
        retryCount += 1;
        metric("coordinator_replica_sync_failure_total");
        event("replica.sync.failed", "error", { reason: "unavailable" });
        scheduleRetry();
        return undefined;
      } finally {
        controller = undefined;
      }
    };
    const syncNow = (): Promise<BootstrapResult | undefined> => {
      if (active) return active;
      if (stopped) return Promise.resolve(undefined);
      clearScheduled();
      active = run().finally(() => { active = undefined; });
      return active;
    };
    const status = (): CoordinatorReplicaSyncStatus => {
      const imported = transfer.status();
      const now = clock();
      const age = lastSuccessfulSync === undefined ? undefined : Math.max(0, now - lastSuccessfulSync);
      if (!stopped && state === "synchronized" && age !== undefined && age > freshnessMs) {
        state = "stale";
        if (!staleReported) {
          staleReported = true;
          metric("coordinator_replica_sync_stale_total");
          event("replica.stale", "warning");
        }
      }
      try {
        const index = ["stopped","bootstrapping","synchronized","stale","conflicted","unavailable","rejected","retry_wait"].indexOf(state);
        options.metrics?.set("coordinator_replica_state", index);
        options.metrics?.set("coordinator_replica_accepted_revision", imported.acceptedRevision ?? 0);
        options.metrics?.set("coordinator_replica_sync_age_seconds", age === undefined ? 0 : age / 1000);
        options.metrics?.set("coordinator_replica_retry_count", retryCount);
      } catch { /* bounded metrics are optional */ }
      return Object.freeze({
        version: 1, state, authorityClassification: "non-authoritative",
        ...(imported.sourceInstanceId ? { sourceInstanceId: imported.sourceInstanceId } : {}),
        ...(imported.acceptedRevision === undefined ? {} : { acceptedRevision: imported.acceptedRevision }),
        ...(imported.snapshotDigest ? { snapshotDigest: imported.snapshotDigest } : {}),
        ...(lastSuccessfulSync === undefined ? {} : { lastSuccessfulSync }),
        ...(lastAttemptedSync === undefined ? {} : { lastAttemptedSync }),
        ...(lastFailure ? { lastFailure } : {}),
        retryCount, ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
        ...(age === undefined ? {} : { synchronizationAgeMs: age }),
        persistenceHealthy: imported.persistenceHealthy,
        ...(imported.lastConflictReason ? { conflictReason: imported.lastConflictReason } : {}),
        bootstrapStatus: state === "synchronized" || state === "stale" ? "ready" : state === "rejected" || state === "unavailable" || state === "conflicted" ? "failed" : "required",
      });
    };
    return {
      async start(): Promise<void> {
        if (!stopped) return;
        stopped = false;
        state = "bootstrapping";
        event("replica.bootstrap.started", "info");
        await syncNow();
        const bootstrapSucceeded = status().state === "synchronized";
        event(bootstrapSucceeded ? "replica.bootstrap.succeeded" : "replica.bootstrap.failed", bootstrapSucceeded ? "info" : "error");
      },
      stop(): void {
        stopped = true;
        clearScheduled();
        controller?.abort();
        state = "stopped";
      },
      syncNow,
      async resetForRebootstrap(): Promise<void> {
        event("replica.rebootstrap.requested", "warning", { action: "reset" });
        clearScheduled();
        controller?.abort();
        if (active) await active;
        retryCount = 0;
        lastFailure = undefined;
        lastSuccessfulSync = undefined;
        metric("coordinator_replica_rebootstrap_total");
        await transfer.resetForRebootstrap();
        state = stopped ? "stopped" : "bootstrapping";
        event("replica.rebootstrap.succeeded", "info");
      },
      async forceSync(): Promise<BootstrapResult | undefined> {
        event("replica.operator.action", "info", { action: "force_sync" });
        return syncNow();
      },
      async clearConflict(): Promise<void> {
        if (state !== "conflicted") return;
        event("replica.operator.action", "warning", { action: "clear_conflict" });
        await this.resetForRebootstrap();
      },
      inspectStatus: status,
      status,
    };
  }
