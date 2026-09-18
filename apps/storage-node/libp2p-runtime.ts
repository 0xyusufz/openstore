/**
 * Standalone libp2p storage-node runtime (Milestone 040).
 *
 * This module deliberately has no HTTP server.  It is the process entry point
 * for nodes which expose the same opaque piece store over libp2p.
 */
import { mkdir, readFile, stat, unlink, writeFile, readdir } from "fs/promises";
import { basename, join, resolve } from "path";
import type { Identity } from "../../packages/identity/index.js";
import { loadIdentity } from "../../packages/identity/keystore.js";
import { DhtPeerDiscovery } from "../../packages/p2p/dht-discovery.js";
import type { P2PPeerDescriptor } from "../../packages/p2p/index.js";
import { createLibp2pStorageNode, type Libp2pStorageNode } from "../../packages/p2p/libp2p.js";
import { isValidPieceId } from "./index.js";
import { createRegistryClient, type RegistryClientOptions } from "../../packages/registry/coordinator.js";
import type { RegistryClient } from "../../packages/registry/coordinator.js";
import { createPieceProvenanceStore } from "./provenance-store.js";
import { createOrphanScanner, type OrphanScanner } from "./orphan-scanner.js";
import { safeErrorMessage } from "./safe-error.js";
import { createCapacityAllocation, type CapacityAllocation } from "./capacity-allocation.js";
import { createProviderAllocationLifecycle, type ProviderAllocationLifecycle, type ProviderAllocationLifecycleSnapshot } from "./provider-allocation-lifecycle.js";

export interface Libp2pStorageNodeRuntimeConfig {
  storageDir: string;
  identityPath: string;
  identityPassword: string;
  listenAddrs?: string[];
  advertisedMultiaddr?: string;
  bootstrapPeers?: P2PPeerDescriptor[];
  capacityBytes?: number;
  /** Enables durable allocation state when set. */
  allocationPath?: string;
  lifecyclePath?: string;
  maxPieceBytes?: number;
  discoveryRefreshIntervalMs?: number;
  coordinatorUrl?: string;
  coordinatorToken?: string;
  heartbeatIntervalMs?: number;
  coordinatorHeartbeatIntervalMs?: number;
  coordinatorRetryAttempts?: number;
  coordinatorRetryBackoffMs?: number;
  coordinatorRetryMaxBackoffMs?: number;
  readinessFile?: string;
  lifecycleEventCallback?: (event: Libp2pStorageNodeLifecycleEvent) => void;
  onLifecycleEvent?: (event: Libp2pStorageNodeLifecycleEvent) => void;
  orphanCleanup?: { enabled?: boolean; gracePeriodMs?: number; intervalMs?: number; batchSize?: number; maxDeletionsPerRun?: number };
}

/** Maximum opaque piece size for the fixed 4 MiB plaintext chunk format. */
export const DEFAULT_MAX_PIECE_BYTES = 8 * 1024 * 1024;

export type Libp2pStorageNodeLifecycleState =
  | "starting" | "registered" | "coordinator-unreachable" | "reconnecting" | "stopped";
export interface Libp2pStorageNodeLifecycleEvent {
  state: Libp2pStorageNodeLifecycleState;
  previousState?: Libp2pStorageNodeLifecycleState;
  type?: string;
  attempt?: number;
  retryCount?: number;
  nextRetryAt?: number;
  error?: string;
}

export interface Libp2pStorageNodeRuntime {
  readonly identity: Identity;
  readonly node: Libp2pStorageNode;
  readonly state: Libp2pStorageNodeLifecycleState;
  readonly status: () => Promise<Libp2pStorageNodeStatusSnapshot>;
  readonly statusSnapshot: () => Promise<Libp2pStorageNodeStatusSnapshot>;
  readonly allocationLifecycle?: ProviderAllocationLifecycle;
  increaseAllocation?(bytes: number): ReturnType<CapacityAllocation["setAllocation"]>;
  decreaseAllocation?(bytes: number): ReturnType<CapacityAllocation["setAllocation"]>;
  stopSharing?(): ProviderAllocationLifecycleSnapshot;
  startSharing?(): ProviderAllocationLifecycleSnapshot;
  resumeSharing?(): ProviderAllocationLifecycleSnapshot;
  releaseAllocation?(): Promise<ProviderAllocationLifecycleSnapshot>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface Libp2pStorageNodeStatusSnapshot {
  peerId: string;
  state: Libp2pStorageNodeLifecycleState;
  coordinatorConfigured: boolean;
  coordinatorConnected: boolean;
  registered: boolean;
  registrationStatus: "registered" | "unregistered" | "registering" | "failed";
  lastSuccessfulRegistrationAt?: number;
  lastSuccessfulHeartbeatAt?: number;
  lastFailureClassification?: string;
  retryAttempt: number;
  retryCount: number;
  nextRetryAt?: number;
  shuttingDown: boolean;
  capacity: { physicalBytes?: number; usableBytes?: number; allocatedBytes: number; usedBytes: number; availableBytes: number };
  lifecycle?: ProviderAllocationLifecycleSnapshot;
}

export function validateLibp2pStorageNodeRuntimeConfig(
  config: unknown,
): asserts config is Libp2pStorageNodeRuntimeConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("runtime config must be an object");
  const value = config as Record<string, unknown>;
  for (const field of ["storageDir", "identityPath", "identityPassword"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.listenAddrs !== undefined && (!Array.isArray(value.listenAddrs) || value.listenAddrs.length === 0 || value.listenAddrs.some((x) => typeof x !== "string" || x.length === 0))) {
    throw new TypeError("listenAddrs must be a non-empty string array");
  }
  if (value.advertisedMultiaddr !== undefined && (typeof value.advertisedMultiaddr !== "string" || value.advertisedMultiaddr.length === 0)) {
    throw new TypeError("advertisedMultiaddr must be a non-empty string");
  }
  if (value.bootstrapPeers !== undefined && (!Array.isArray(value.bootstrapPeers))) throw new TypeError("bootstrapPeers must be an array");
  if (value.coordinatorUrl !== undefined) {
    if (typeof value.coordinatorUrl !== "string" || !/^https?:\/\//.test(value.coordinatorUrl)) throw new TypeError("coordinatorUrl must be an HTTP URL");
  }
  if (value.coordinatorToken !== undefined && (typeof value.coordinatorToken !== "string" || value.coordinatorToken.length === 0)) throw new TypeError("coordinatorToken must be a non-empty string");
  if (value.allocationPath !== undefined && (typeof value.allocationPath !== "string" || value.allocationPath.length === 0)) throw new TypeError("allocationPath must be a non-empty string");
  if (value.lifecyclePath !== undefined && (typeof value.lifecyclePath !== "string" || value.lifecyclePath.length === 0)) throw new TypeError("lifecyclePath must be a non-empty string");
  if (value.readinessFile !== undefined && (typeof value.readinessFile !== "string" || value.readinessFile.length === 0)) throw new TypeError("readinessFile must be a non-empty string");
  for (const field of ["capacityBytes", "maxPieceBytes", "discoveryRefreshIntervalMs", "heartbeatIntervalMs", "coordinatorHeartbeatIntervalMs", "coordinatorRetryAttempts", "coordinatorRetryBackoffMs", "coordinatorRetryMaxBackoffMs"]) {
    const n = value[field];
    if (n !== undefined && (!Number.isSafeInteger(n) || (n as number) <= 0)) throw new TypeError(`${field} must be a positive safe integer`);
  }
}

export async function createLibp2pStorageNodeRuntime(
  input: Libp2pStorageNodeRuntimeConfig,
): Promise<Libp2pStorageNodeRuntime> {
  validateLibp2pStorageNodeRuntimeConfig(input);
  const identity = await loadIdentity(input.identityPassword, resolve(input.identityPath));
  const storageDir = resolve(input.storageDir);
  await mkdir(storageDir, { recursive: true });
  let allocation: CapacityAllocation | undefined;
  if (input.allocationPath) {
    allocation = createCapacityAllocation(storageDir, input.capacityBytes, resolve(input.allocationPath));
  }
  const initialCapacity = allocation?.state().allocationBytes ?? input.capacityBytes ?? 1 * 1024 * 1024 * 1024;
  const lifecycle = allocation ? createProviderAllocationLifecycle(resolve(input.lifecyclePath ?? join(storageDir, ".provider-lifecycle.json"))) : undefined;
  const store = createPieceStore(storageDir, initialCapacity, input.maxPieceBytes ?? DEFAULT_MAX_PIECE_BYTES, allocation, allocation ? basename(allocation.path) : undefined, lifecycle ? basename(lifecycle.path) : undefined, lifecycle);
  if (allocation) allocation.updateUsed(await store.usedBytes());
  const provenance = createPieceProvenanceStore(join(storageDir, ".provenance"), input.orphanCleanup?.gracePeriodMs);
  let orphanScanner: OrphanScanner | undefined;
  if (input.orphanCleanup?.enabled) {
    orphanScanner = createOrphanScanner({
      pieceDir: storageDir,
      provenance,
      intervalMs: input.orphanCleanup.intervalMs,
      batchSize: input.orphanCleanup.batchSize,
      maxDeletionsPerRun: input.orphanCleanup.maxDeletionsPerRun,
      deletePiece: async (pieceId) => (await store.remove(pieceId)) === 404 ? "not-found" : "deleted",
    });
  }
  const discovery = new DhtPeerDiscovery(input.bootstrapPeers ?? []);
  const node = await createLibp2pStorageNode({
    applicationIdentity: { publicKey: identity.publicKey.toString("base64") },
    applicationPrivateKey: identity.privateKey,
    listenAddrs: input.listenAddrs,
    maxPieceBytes: input.maxPieceBytes ?? DEFAULT_MAX_PIECE_BYTES,
    allocatedBytes: initialCapacity,
    availableBytes: initialCapacity,
    discovery,
    discoveryRefreshIntervalMs: input.discoveryRefreshIntervalMs,
    storePiece: store.store,
    getPiece: store.get,
    deletePiece: store.remove,
    provenance,
  });
  const coordinator: RegistryClient | undefined = input.coordinatorUrl
    ? createRegistryClient({ baseUrl: input.coordinatorUrl, token: input.coordinatorToken } satisfies RegistryClientOptions)
    : undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let registered = false;
  let state: Libp2pStorageNodeLifecycleState = "stopped";
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let registrationPromise: Promise<void> | undefined;
  let stopping = false;
  let coordinatorConnected = false;
  let registrationStatus: Libp2pStorageNodeStatusSnapshot["registrationStatus"] = "unregistered";
  let lastSuccessfulRegistrationAt: number | undefined;
  let lastSuccessfulHeartbeatAt: number | undefined;
  let lastFailureClassification: string | undefined;
  let retryAttempt = 0;
  let retryCount = 0;
  let nextRetryAt: number | undefined;
  const descriptor = async (snapshot: { allocatedBytes: number; availableBytes: number }) => ({
    nodeId: node.peerId,
    baseUrl: `libp2p://${node.peerId}`,
    multiaddr: input.advertisedMultiaddr ? `${input.advertisedMultiaddr}/p2p/${node.peerId}` : node.listenAddrs[0],
    identity: node.applicationIdentity,
    identityBinding: node.peerId,
    capabilities: { ...node.capabilities, ...snapshot, ...(lifecycle ? { lifecycle: lifecycle.inspect().state } : {}) },
  });
  const capacitySnapshot = async () => {
    const usedBytes = await store.usedBytes();
    const stateSnapshot = allocation?.state();
    const allocatedBytes = stateSnapshot?.allocationBytes ?? initialCapacity;
    return {
      allocatedBytes,
      usedBytes,
      availableBytes: Math.max(0, allocatedBytes - usedBytes - (stateSnapshot?.reservedBytes ?? 0)),
      ...(stateSnapshot ? { physicalBytes: stateSnapshot.physicalBytes, usableBytes: stateSnapshot.usableBytes } : {}),
      ...(lifecycle ? { lifecycle: lifecycle.inspect().state } : {}),
    };
  };
  const status = async (): Promise<Libp2pStorageNodeStatusSnapshot> => {
    const capacity = await capacitySnapshot();
    return { peerId: node.peerId, state, coordinatorConfigured: Boolean(coordinator), coordinatorConnected, registered, registrationStatus, lastSuccessfulRegistrationAt, lastSuccessfulHeartbeatAt, lastFailureClassification, retryAttempt, retryCount, nextRetryAt, shuttingDown: stopping, capacity, ...(lifecycle ? { lifecycle: lifecycle.inspect() } : {}) };
  };
  const emit = (next: Libp2pStorageNodeLifecycleState, error?: unknown, eventType?: string, attempt?: number) => {
    const previousState = state;
    state = next;
    if (previousState === next && !error && !eventType) return;
    try {
      const event = {
        state: next,
        previousState,
        type: eventType ?? next,
        ...(attempt === undefined ? {} : { attempt }),
        retryCount,
        ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
        ...(error === undefined ? {} : { error: safeLifecycleError(error) }),
      };
      input.lifecycleEventCallback?.(event);
      if (input.onLifecycleEvent && input.onLifecycleEvent !== input.lifecycleEventCallback) input.onLifecycleEvent(event);
    } catch { /* observers must not affect lifecycle */ }
  };
  const retryAttempts = input.coordinatorRetryAttempts ?? 3;
  const retryBackoff = input.coordinatorRetryBackoffMs ?? 250;
  const retryMaxBackoff = input.coordinatorRetryMaxBackoffMs ?? 5_000;
  const interval = input.coordinatorHeartbeatIntervalMs ?? input.heartbeatIntervalMs ??
    Math.max(1000, Math.floor((input.discoveryRefreshIntervalMs ?? 30_000) / 3));
  const delay = (attempt: number) => Math.min(retryMaxBackoff, retryBackoff * 2 ** attempt);
  const isNodeMissing = (error: unknown) => /node\s+not\s+found|not\s+registered|state\s+lost/i.test(error instanceof Error ? error.message : String(error));
  const clearTimers = () => {
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = undefined; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
  };
  const performRegister = async () => {
    if (!coordinator) return;
    registrationStatus = "registering";
    emit(state === "stopped" ? "starting" : state, undefined, "registration.attempt", 0);
    let lastError: unknown;
    for (let attempt = 0; attempt < retryAttempts; attempt++) {
      if (stopping || state === "stopped") return;
      try {
        emit("reconnecting", undefined, "registration.attempt", attempt);
        const snapshot = await capacitySnapshot();
        await coordinator.registerLibp2pWithIdentity(identity, await descriptor(snapshot), snapshot);
        registered = true;
        registrationStatus = "registered";
        coordinatorConnected = true;
        lastSuccessfulRegistrationAt = Date.now();
        lastFailureClassification = undefined;
        retryAttempt = 0;
        nextRetryAt = undefined;
        emit("registered", undefined, "registration.success");
        if (!stopping) scheduleHeartbeat();
        return;
      } catch (error) {
        lastError = error;
        coordinatorConnected = false;
        registrationStatus = "failed";
        lastFailureClassification = (error as { classification?: string }).classification ?? "unknown";
        emit("coordinator-unreachable", error, "registration.failure", attempt);
        retryAttempt = attempt + 1;
        retryCount++;
        emit("coordinator-unreachable", error, "connection.lost");
        if (attempt + 1 < retryAttempts) await new Promise<void>((resolve) => setTimeout(resolve, delay(attempt)));
      }
    }
    registered = false;
    registrationStatus = "failed";
    emit("coordinator-unreachable", lastError);
    if (!stopping && state !== "stopped" && !reconnectTimer) {
      nextRetryAt = Date.now() + delay(retryAttempts);
      emit("reconnecting", undefined, "retry.scheduled");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (stopping || state === "stopped") return;
        emit("reconnecting");
        void register();
      }, delay(retryAttempts));
    }
  };
  const register = () => registrationPromise ??= performRegister().finally(() => { registrationPromise = undefined; });
  const scheduleHeartbeat = () => {
    if (!coordinator || stopping || state === "stopped" || !registered) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      void (async () => {
        try {
          const snapshot = await capacitySnapshot();
          await coordinator.heartbeatLibp2pWithIdentity(identity, await descriptor(snapshot), snapshot);
          lastSuccessfulHeartbeatAt = Date.now();
          emit("registered", undefined, "heartbeat.success");
          coordinatorConnected = true;
          lastFailureClassification = undefined;
          emit("registered", undefined, "connection.recovered");
          scheduleHeartbeat();
        } catch (error) {
          registered = false;
          coordinatorConnected = false;
          emit("coordinator-unreachable", error, "heartbeat.failure");
          lastFailureClassification = (error as { classification?: string }).classification ?? "unknown";
          emit(isNodeMissing(error) ? "reconnecting" : "coordinator-unreachable", error);
          if (isNodeMissing(error)) void register();
          else if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => { reconnectTimer = undefined; emit("reconnecting"); void register(); }, delay(0));
          }
        }
      })();
    }, interval);
  };
  const start = async () => {
    if (state === "registered" || state === "coordinator-unreachable" || state === "reconnecting") return;
    stopping = false;
    emit("starting");
    await node.start();
    orphanScanner?.start();
    if (input.readinessFile) {
      await writeFile(input.readinessFile, `${process.pid}\n`, { mode: 0o600 });
    }
    if (coordinator) {
      await register();
    } else emit("registered");
  };
  const stop = async () => {
    stopping = true;
    coordinatorConnected = false;
    nextRetryAt = undefined;
    emit("stopped", undefined, "shutdown");
    clearTimers();
    if (startPromise) await startPromise;
    if (registrationPromise) await registrationPromise;
    if (coordinator && registered) {
      try { await coordinator.unregisterWithIdentity(identity, node.peerId); } catch { /* coordinator may already be unavailable */ }
      registered = false;
    }
    await orphanScanner?.stop();
    await node.stop();
    if (input.readinessFile) {
      try { await unlink(input.readinessFile); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    registrationStatus = "unregistered";
    emit("stopped", undefined, "shutdown.completed");
  };
  return {
    identity,
    node,
    get state() { return state; },
    status,
    statusSnapshot: status,
    ...(lifecycle ? {
      allocationLifecycle: lifecycle,
      increaseAllocation: (bytes: number) => {
        if (lifecycle.inspect().state === "released") throw new Error("released allocation cannot be resized");
        return allocation!.setAllocation(bytes);
      },
      decreaseAllocation: (bytes: number) => {
        if (lifecycle.inspect().state === "released") throw new Error("released allocation cannot be resized");
        return allocation!.setAllocation(bytes);
      },
      stopSharing: () => lifecycle.stopSharing(),
      startSharing: () => {
        const current = allocation!.state();
        allocation!.setAllocation(current.allocationBytes, current.usedBytes);
        return lifecycle.startSharing();
      },
      resumeSharing: () => {
        const current = allocation!.state();
        allocation!.setAllocation(current.allocationBytes, current.usedBytes);
        return lifecycle.startSharing();
      },
      releaseAllocation: async () => lifecycle.release(await store.usedBytes(), allocation!.state().reservedBytes),
    } : {}),
    start() { return startPromise ??= start().finally(() => { startPromise = undefined; }); },
    stop() { return stopPromise ??= stop().finally(() => { stopPromise = undefined; }); },
  };
}

function safeLifecycleError(error: unknown): string {
  return safeErrorMessage(error);
}

function createPieceStore(dir: string, capacity: number, maxPieceBytes?: number, allocation?: CapacityAllocation, allocationFileName?: string, lifecycleFileName?: string, lifecycle?: ProviderAllocationLifecycle) {
  const pathFor = (id: string) => {
    if (!isValidPieceId(id)) throw new Error("invalid piece id");
    return join(dir, id);
  };
  const used = async () => {
    let total = 0;
    for (const name of await readdir(dir)) {
      if (name === allocationFileName || name === lifecycleFileName ||
          name === ".capacity-allocation.json" || name.startsWith(".capacity-allocation.json.tmp-") ||
          (allocationFileName !== undefined && name.startsWith(`${allocationFileName}.tmp-`)) ||
          name === ".provider-lifecycle.json" || name.startsWith(".provider-lifecycle.json.tmp-") ||
          (lifecycleFileName !== undefined && name.startsWith(`${lifecycleFileName}.tmp-`))) continue;
      try { const item = await stat(join(dir, name)); if (item.isFile()) total += item.size; } catch { /* concurrent deletion */ }
    }
    return total;
  };
  return {
    async usedBytes() {
      return used();
    },
    async store(id: string, data: Buffer) {
      if (lifecycle && lifecycle.inspect().state !== "sharing") return 503;
      if (maxPieceBytes !== undefined && data.length > maxPieceBytes) return 413;
      const path = pathFor(id);
      let previous = 0;
      let existed = false;
      try { previous = (await stat(path)).size; existed = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const current = await used();
      const limit = allocation?.state().allocationBytes ?? capacity;
      if (current - previous + data.length > limit) return 507;
      await writeFile(path, data, { mode: 0o600 });
      allocation?.updateUsed(await used());
      return existed ? 200 : 201;
    },
    async get(id: string) {
      try { return await readFile(pathFor(id)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(id: string) {
      try { await unlink(pathFor(id)); allocation?.updateUsed(await used()); return 204; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 404;
        throw error;
      }
    },
  };
}
