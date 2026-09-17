import type { EventStore } from "../events/index.js";
import type { MetricsRegistry } from "../metrics/index.js";
import type { Registry } from "../registry/index.js";
import {
  type CoordinatorBootstrapSnapshot,
  type CoordinatorReplicaBootstrapResponse,
  type CoordinatorReplicaBootstrapRequest,
  type CoordinatorReplicaBootstrapStatus,
  type CoordinatorReplicaSyncManager,
  type CoordinatorReplicaSyncSource,
  type CoordinatorReplicaSyncStatus,
  type BootstrapResult,
  type CoordinatorSnapshotExporter,
  type CoordinatorInstanceIdentity,
  createCoordinatorReplicaSyncManager,
  createCoordinatorSnapshotExporter,
  CoordinatorReplicaImporter,
} from "./index.js";
import type { AuthorityControlPlane } from "./authority-control-plane.js";

export type CoordinatorHaRole = "standalone" | "replica-observer";

export interface CoordinatorHaConfig {
  readonly enabled: boolean;
  readonly role: CoordinatorHaRole;
  readonly trustedInstanceId?: string;
  readonly syncIntervalMs: number;
  readonly staleAfterMs: number;
}

const INSTANCE_ID = /^coord-[a-f0-9]{32}$/;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;

function bounded(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 86_400_000) throw new TypeError("coordinator HA timing is invalid");
  return parsed;
}

export function parseCoordinatorHaConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorHaConfig {
  const enabled = env.OPENSTORE_COORDINATOR_HA_ENABLED === "true";
  const role = env.OPENSTORE_COORDINATOR_HA_ROLE ?? "standalone";
  if (role !== "standalone" && role !== "replica-observer") throw new TypeError("coordinator HA role is invalid");
  const config: CoordinatorHaConfig = {
    enabled,
    role,
    syncIntervalMs: bounded(env.OPENSTORE_COORDINATOR_HA_SYNC_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    staleAfterMs: bounded(env.OPENSTORE_COORDINATOR_HA_STALE_AFTER_MS, DEFAULT_STALE_AFTER_MS),
    ...(env.OPENSTORE_COORDINATOR_HA_TRUSTED_INSTANCE_ID ? { trustedInstanceId: env.OPENSTORE_COORDINATOR_HA_TRUSTED_INSTANCE_ID } : {}),
  };
  if (!enabled && role !== "standalone") throw new TypeError("disabled coordinator HA must use standalone role");
  if (config.trustedInstanceId !== undefined && !INSTANCE_ID.test(config.trustedInstanceId)) throw new TypeError("trusted coordinator instance ID is invalid");
  if (enabled && role === "replica-observer" && !config.trustedInstanceId) throw new TypeError("replica-observer requires a trusted coordinator instance ID");
  return Object.freeze(config);
}

export interface CoordinatorHaAdapter {
  readonly config: CoordinatorHaConfig;
  readonly authorityControlPlane?: AuthorityControlPlane;
  exportState(request?: CoordinatorReplicaBootstrapRequest): Promise<CoordinatorReplicaBootstrapResponse>;
  importState(response: CoordinatorReplicaBootstrapResponse, transportAuthenticated: boolean): Promise<BootstrapResult>;
  status(): CoordinatorReplicaSyncStatus | CoordinatorReplicaBootstrapStatus;
  start(): Promise<void>;
  stop(): void;
  forceSync(): Promise<Awaited<ReturnType<CoordinatorReplicaSyncManager["syncNow"]>>>;
  resetForRebootstrap(): Promise<void>;
}

export interface CoordinatorHaAdapterOptions {
  readonly config: CoordinatorHaConfig;
  readonly registry: Registry;
  readonly instance: CoordinatorInstanceIdentity;
  readonly signingKey?: Buffer;
  readonly revision?: () => number;
  readonly source?: CoordinatorReplicaSyncSource;
  readonly persistencePath?: string;
  readonly metrics?: MetricsRegistry;
  readonly events?: EventStore;
  readonly exportSnapshot?: () => CoordinatorBootstrapSnapshot;
  readonly authorityControlPlane?: AuthorityControlPlane;
}

function snapshotFromRegistry(registry: Registry, instance: CoordinatorInstanceIdentity, revision: number, observedAt: number): CoordinatorBootstrapSnapshot {
  return {
    version: 1,
    instance,
    revision,
    observedAt,
    nodes: registry.list().map((node) => ({
      nodeId: node.nodeId,
      publicKey: node.publicKey,
      endpoint: node.baseUrl,
      available: node.available,
      lastSeen: node.lastSeen,
      capacity: {
        allocatedBytes: node.capacity.allocatedBytes ?? node.capacity.totalBytes ?? 0,
        usedBytes: node.capacity.usedBytes,
        availableBytes: node.capacity.availableBytes,
      },
      reliability: { ...node.reliability },
      ...(node.transport ? { transport: node.transport } : {}),
      ...(node.multiaddr ? { multiaddr: node.multiaddr } : {}),
      ...(node.identityBinding ? { identityBinding: node.identityBinding } : {}),
    })),
  };
}

export function createCoordinatorHaAdapter(options: CoordinatorHaAdapterOptions): CoordinatorHaAdapter {
  const { config } = options;
  const exporter: CoordinatorSnapshotExporter | undefined = options.signingKey
    ? createCoordinatorSnapshotExporter(
      () => options.exportSnapshot?.() ?? snapshotFromRegistry(options.registry, options.instance, options.revision?.() ?? 0, Date.now()),
      options.signingKey,
    )
    : undefined;
  if (config.role === "standalone" && !exporter) throw new TypeError("standalone coordinator export requires a signing key");
  if (config.role === "replica-observer" && !options.source) throw new TypeError("replica-observer requires a state source");
  const importer = config.role === "replica-observer"
    ? new CoordinatorReplicaImporter({ trustedInstanceIds: [config.trustedInstanceId as string], persistencePath: options.persistencePath })
    : undefined;
  const sync = importer && options.source
    ? createCoordinatorReplicaSyncManager(options.source, importer, { freshnessMs: config.staleAfterMs, metrics: options.metrics, events: options.events })
    : undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  return {
    config,
    authorityControlPlane: options.authorityControlPlane,
    async exportState(request = { version: 1 }): Promise<CoordinatorReplicaBootstrapResponse> {
      if (!exporter) throw new Error("coordinator HA export is unavailable");
      return exporter.request(request);
    },
    async importState(response, transportAuthenticated) {
      if (!importer) throw new Error("coordinator HA import is unavailable");
      return importer.import(response, transportAuthenticated);
    },
    status() {
      if (sync) return sync.status();
      if (importer) return importer.status();
      return {
        version: 1,
        state: "uninitialized",
        authorityClassification: "non-authoritative",
        persistenceHealthy: true,
      };
    },
    async start() {
      if (!sync) return;
      await sync.start();
      if (!interval) {
        interval = setInterval(() => { void sync.syncNow(); }, config.syncIntervalMs);
        interval.unref?.();
      }
    },
    stop() {
      if (interval) { clearInterval(interval); interval = undefined; }
      sync?.stop();
    },
    async forceSync() { return sync?.forceSync(); },
    async resetForRebootstrap() { if (sync) await sync.resetForRebootstrap(); else if (importer) await importer.resetForRebootstrap(); },
  };
}
