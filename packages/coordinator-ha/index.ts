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
