import type { FileManifest } from "../../packages/manifest/index.js";
import type { ManifestStore } from "../../packages/manifest/store.js";
import type { CoordinatorEndpointProvider } from "./index.js";
import {
  repairManifestReplica,
  RepairError,
  type RepairOptions,
  type RepairReport,
} from "./repair.js";
import { defaultMetrics, type MetricsRegistry } from "../../packages/metrics/index.js";
import { defaultEvents, type EventStore } from "../../packages/events/index.js";

export type RepairSchedulerState = "stopped" | "running" | "paused";
export type RepairLifecycle =
  | "queued"
  | "observing"
  | "confirmed-loss"
  | "repairing"
  | "completed"
  | "failed"
  | "cancelled"
  | "node-recovered";

export interface RepairSchedulerEvent {
  type:
    | "repair.scheduler.started"
    | "repair.scheduler.stopped"
    | "repair.scheduler.paused"
    | "repair.queued"
    | "repair.observing"
    | "repair.confirmed-loss"
    | "repair.repairing"
    | "repair.completed"
    | "repair.failed"
    | "repair.cancelled"
    | "repair.node-recovered";
  lifecycle?: RepairLifecycle;
  fileId?: string;
  chunkIndex?: number;
  pieceId?: string;
  lostNodeId?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  classification?: RepairError["classification"];
  attempt?: number;
  retryCount?: number;
  queueDepth: number;
  activeCount: number;
  timestamp: number;
}

export interface RepairSchedulerStatus {
  state: RepairSchedulerState;
  queuedCount: number;
  observingCount: number;
  activeRepairCount: number;
  completedCount: number;
  failedCounts: Partial<Record<RepairError["classification"], number>>;
  cancelledCount: number;
  lastSuccessfulRepairTime?: number;
  lastSchedulerErrorClassification?: RepairError["classification"];
  perFileActiveCount: Record<string, number>;
  cooldownCount: number;
}

export interface RepairSchedulerOptions {
  manifestStore: ManifestStore;
  coordinator: CoordinatorEndpointProvider;
  repair?: (fileId: string, options: RepairOptions) => Promise<RepairReport>;
  options?: {
    intervalMs?: number;
    globalConcurrency?: number;
    perFileConcurrency?: number;
    maxQueuedCandidates?: number;
    maxRetryRounds?: number;
    retryBackoffMs?: number;
    maxRetryBackoffMs?: number;
    repairOptions?: Omit<RepairOptions, "manifestStore" | "coordinator" | "lostNodeId" | "chunkIndex" | "signal">;
    onEvent?: (event: RepairSchedulerEvent) => void;
    metrics?: MetricsRegistry;
    events?: EventStore;
  };
}

export interface RepairScheduler {
  start(): void;
  stop(): void;
  cancel(): void;
  tick(): Promise<RepairSchedulerStatus>;
  runOnce(): Promise<RepairSchedulerStatus>;
  readonly status: RepairSchedulerStatus;
}

interface Candidate {
  key: string;
  fileId: string;
  chunkIndex: number;
  pieceId: string;
  lostNodeId: string;
  retryCount: number;
  nextAttemptAt: number;
  cooldownUntil?: number;
  controller?: AbortController;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_GLOBAL_CONCURRENCY = 2;
const DEFAULT_PER_FILE_CONCURRENCY = 1;
const DEFAULT_MAX_QUEUED = 100;
const DEFAULT_MAX_RETRY_ROUNDS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 250;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 10_000;

export function createRepairScheduler(input: RepairSchedulerOptions): RepairScheduler {
  const metrics = input.options?.metrics ?? defaultMetrics;
  const events = input.options?.events ?? defaultEvents;
  if (!input || typeof input !== "object") throw new TypeError("options must be an object");
  if (!input.manifestStore || typeof input.manifestStore.list !== "function" || typeof input.manifestStore.load !== "function") {
    throw new TypeError("manifestStore must expose list and load");
  }
  if (!input.coordinator || typeof input.coordinator.refresh !== "function") {
    throw new TypeError("coordinator must expose refresh");
  }
  const options = input.options ?? {};
  const intervalMs = positiveInteger(options.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs");
  const globalConcurrency = positiveInteger(options.globalConcurrency ?? DEFAULT_GLOBAL_CONCURRENCY, "globalConcurrency");
  const perFileConcurrency = positiveInteger(options.perFileConcurrency ?? DEFAULT_PER_FILE_CONCURRENCY, "perFileConcurrency");
  const maxQueued = positiveInteger(options.maxQueuedCandidates ?? DEFAULT_MAX_QUEUED, "maxQueuedCandidates");
  const maxRetryRounds = positiveInteger(options.maxRetryRounds ?? DEFAULT_MAX_RETRY_ROUNDS, "maxRetryRounds");
  const retryBackoffMs = nonNegativeInteger(options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS, "retryBackoffMs");
  const maxRetryBackoffMs = nonNegativeInteger(options.maxRetryBackoffMs ?? DEFAULT_MAX_RETRY_BACKOFF_MS, "maxRetryBackoffMs");
  const repair = input.repair ?? repairManifestReplica;

  let state: RepairSchedulerState = "stopped";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tickPromise: Promise<RepairSchedulerStatus> | undefined;
  const pending = new Map<string, Candidate>();
  const inFlight = new Map<string, Candidate>();
  const observing = new Set<string>();
  const cooldowns = new Map<string, number>();
  const fileActive = new Map<string, number>();
  const statusValue: RepairSchedulerStatus = {
    state,
    queuedCount: 0,
    observingCount: 0,
    activeRepairCount: 0,
    completedCount: 0,
    failedCounts: {},
    cancelledCount: 0,
    perFileActiveCount: {},
    cooldownCount: 0,
  };

  function emit(event: Omit<RepairSchedulerEvent, "queueDepth" | "activeCount" | "timestamp">): void {
    if (event.type === "repair.confirmed-loss") metrics.increment("repair_confirmed_loss_total", 1, { result: "success" });
    if (event.type === "repair.repairing") metrics.increment("repair_attempts_total", 1, { result: "success" });
    if (event.type === "repair.completed") metrics.increment("repair_success_total", 1, { result: "success" });
    if (event.type === "repair.failed") metrics.increment("repair_failures_total", 1, { result: "error" });
    try {
      const type = event.type === "repair.confirmed-loss" ? "repair.confirmed-loss" : event.type === "repair.repairing" ? "repair.attempt" : event.type === "repair.completed" ? "repair.completed" : event.type === "repair.failed" ? "repair.failed" : undefined;
      if (type) events.append({ version: 1, timestamp: Date.now(), component: "repair", type, severity: type === "repair.failed" ? "error" : "info", details: { ...(event.attempt !== undefined ? { attempt: event.attempt } : {}), ...(event.retryCount !== undefined ? { retryCount: event.retryCount } : {}), queueDepth: pending.size, activeCount: inFlight.size } });
    } catch {}
    options.onEvent?.({
      ...event,
      queueDepth: pending.size,
      activeCount: inFlight.size,
      timestamp: Date.now(),
    });
  }

  function syncStatus(): void {
    statusValue.state = state;
    statusValue.queuedCount = pending.size;
    statusValue.observingCount = observing.size;
    statusValue.activeRepairCount = inFlight.size;
    statusValue.perFileActiveCount = Object.fromEntries(fileActive);
    statusValue.cooldownCount = [...cooldowns.values()].filter((until) => until > Date.now()).length;
  }

  async function discover(): Promise<void> {
    let available;
    try {
      available = await input.coordinator.refresh();
    } catch (error) {
      const classification: RepairError["classification"] = "coordinator-unavailable";
      statusValue.lastSchedulerErrorClassification = classification;
      for (const candidate of pending.values()) {
        scheduleFailure(candidate, classification);
      }
      syncStatus();
      return;
    }
    const availableIds = new Set(available.map((endpoint) => endpoint.id));
    for (const candidate of [...pending.values(), ...inFlight.values()]) {
      if (availableIds.has(candidate.lostNodeId)) {
        candidate.controller?.abort();
        pending.delete(candidate.key);
        inFlight.delete(candidate.key);
        observing.delete(candidate.key);
        cooldowns.delete(candidate.key);
        emit({ type: "repair.node-recovered", lifecycle: "node-recovered", ...candidateFields(candidate) });
      }
    }

    const summaries = await input.manifestStore.list();
    for (const summary of summaries) {
      if (pending.size >= maxQueued) break;
      let manifest: FileManifest | undefined;
      try {
        manifest = await input.manifestStore.load(summary.fileId);
      } catch {
        continue;
      }
      if (!manifest) continue;
      for (const chunk of manifest.chunks) {
        for (const lostNodeId of chunk.nodeIds) {
          if (availableIds.has(lostNodeId)) continue;
          const key = `${manifest.fileId}:${chunk.index}:${chunk.pieceId}:${lostNodeId}`;
          if (pending.has(key) || inFlight.has(key)) continue;
          const cooldownUntil = cooldowns.get(key);
          if (cooldownUntil !== undefined && cooldownUntil > Date.now()) continue;
          cooldowns.delete(key);
          const candidate: Candidate = {
            key,
            fileId: manifest.fileId,
            chunkIndex: chunk.index,
            pieceId: chunk.pieceId,
            lostNodeId,
            retryCount: 0,
            nextAttemptAt: Date.now(),
          };
          pending.set(key, candidate);
          emit({ type: "repair.queued", lifecycle: "queued", ...candidateFields(candidate) });
          if (pending.size >= maxQueued) break;
        }
        if (pending.size >= maxQueued) break;
      }
    }
  }

  async function execute(candidate: Candidate): Promise<void> {
    pending.delete(candidate.key);
    inFlight.set(candidate.key, candidate);
    observing.add(candidate.key);
    candidate.controller = new AbortController();
    fileActive.set(candidate.fileId, (fileActive.get(candidate.fileId) ?? 0) + 1);
    syncStatus();
    emit({ type: "repair.observing", lifecycle: "observing", ...candidateFields(candidate) });
    emit({ type: "repair.confirmed-loss", lifecycle: "confirmed-loss", ...candidateFields(candidate) });
    observing.delete(candidate.key);
    emit({ type: "repair.repairing", lifecycle: "repairing", ...candidateFields(candidate), attempt: candidate.retryCount + 1, retryCount: candidate.retryCount });
    try {
      const report = await repair(candidate.fileId, {
        ...options.repairOptions,
        manifestStore: input.manifestStore,
        coordinator: input.coordinator,
        lostNodeId: candidate.lostNodeId,
        chunkIndex: candidate.chunkIndex,
        signal: candidate.controller.signal,
      });
      const repaired = report.chunks.find((chunk) => chunk.chunkIndex === candidate.chunkIndex);
      statusValue.completedCount += 1;
      statusValue.lastSuccessfulRepairTime = Date.now();
      emit({
        type: "repair.completed",
        lifecycle: "completed",
        ...candidateFields(candidate),
        ...(repaired?.sourceNodeId ? { sourceNodeId: repaired.sourceNodeId } : {}),
        ...(repaired?.addedNodeId ? { targetNodeId: repaired.addedNodeId } : {}),
        retryCount: candidate.retryCount,
      });
    } catch (error) {
      const classification = error instanceof RepairError ? error.classification : "failed";
      if (candidate.controller.signal.aborted || classification === "cancelled") {
        statusValue.cancelledCount += 1;
        emit({ type: "repair.cancelled", lifecycle: "cancelled", ...candidateFields(candidate), classification });
      } else if (/reappeared|recovered/i.test(error instanceof Error ? error.message : "")) {
        emit({ type: "repair.node-recovered", lifecycle: "node-recovered", ...candidateFields(candidate) });
      } else {
        scheduleFailure(candidate, classification);
      }
    } finally {
      inFlight.delete(candidate.key);
      observing.delete(candidate.key);
      const active = (fileActive.get(candidate.fileId) ?? 1) - 1;
      if (active > 0) fileActive.set(candidate.fileId, active);
      else fileActive.delete(candidate.fileId);
      syncStatus();
    }
  }

  function scheduleFailure(candidate: Candidate, classification: RepairError["classification"]): void {
    statusValue.failedCounts[classification] = (statusValue.failedCounts[classification] ?? 0) + 1;
    statusValue.lastSchedulerErrorClassification = classification;
    candidate.retryCount += 1;
    if (candidate.retryCount > maxRetryRounds || state === "stopped") {
      cooldowns.set(candidate.key, Date.now() + maxRetryBackoffMs);
    } else {
      const delay = Math.min(maxRetryBackoffMs, retryBackoffMs * (2 ** Math.max(0, candidate.retryCount - 1)));
      candidate.nextAttemptAt = Date.now() + delay;
      pending.set(candidate.key, candidate);
      cooldowns.set(candidate.key, candidate.nextAttemptAt);
    }
    emit({ type: "repair.failed", lifecycle: "failed", ...candidateFields(candidate), classification, retryCount: candidate.retryCount });
  }

  async function drain(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const candidate of pending.values()) {
      if (inFlight.size + work.length >= globalConcurrency) break;
      if (candidate.nextAttemptAt > Date.now()) continue;
      if ((fileActive.get(candidate.fileId) ?? 0) >= perFileConcurrency) continue;
      work.push(execute(candidate));
    }
    await Promise.all(work);
  }

  async function runOnce(): Promise<RepairSchedulerStatus> {
    if (tickPromise) return tickPromise;
    tickPromise = (async () => {
      if (state === "stopped") {
        state = "paused";
        syncStatus();
      }
      await discover();
      await drain();
      syncStatus();
      return cloneStatus(statusValue);
    })().finally(() => { tickPromise = undefined; });
    return tickPromise;
  }

  function scheduleNext(): void {
    if (state !== "running") return;
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce().finally(scheduleNext);
    }, intervalMs);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
  }

  return {
    start(): void {
      if (state === "running") return;
      state = "running";
      syncStatus();
      emit({ type: "repair.scheduler.started" });
      void runOnce().finally(scheduleNext);
    },
    stop(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const candidate of inFlight.values()) candidate.controller?.abort();
      state = "stopped";
      syncStatus();
      emit({ type: "repair.scheduler.stopped" });
    },
    cancel(): void {
      for (const candidate of pending.values()) {
        statusValue.cancelledCount += 1;
        emit({ type: "repair.cancelled", lifecycle: "cancelled", ...candidateFields(candidate), classification: "cancelled" });
      }
      pending.clear();
      for (const candidate of inFlight.values()) candidate.controller?.abort();
      state = "paused";
      syncStatus();
      emit({ type: "repair.scheduler.paused" });
    },
    tick: runOnce,
    runOnce,
    get status(): RepairSchedulerStatus {
      syncStatus();
      return cloneStatus(statusValue);
    },
  };
}

function candidateFields(candidate: Candidate): Pick<RepairSchedulerEvent, "fileId" | "chunkIndex" | "pieceId" | "lostNodeId"> {
  return {
    fileId: candidate.fileId,
    chunkIndex: candidate.chunkIndex,
    pieceId: candidate.pieceId,
    lostNodeId: candidate.lostNodeId,
  };
}

function cloneStatus(status: RepairSchedulerStatus): RepairSchedulerStatus {
  return {
    ...status,
    failedCounts: { ...status.failedCounts },
    perFileActiveCount: { ...status.perFileActiveCount },
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}
