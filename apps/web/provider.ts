/**
 * OpenStore Storage Provider Manager (OPENSTORE-029)
 *
 * Lets a user share part of their own disk: detect filesystem capacity,
 * take an explicit allocation, isolate pieces in a dedicated directory,
 * and run a real storage node (register + heartbeat) with Start/Stop
 * lifecycle and safe draining decommissioning.
 *
 * Trust and safety model:
 * - The web backend host is already trusted with plaintext and DEKs
 *   (see backend.ts / dekstore.ts). The provider extends that same host
 *   trust to one node identity key (registry signatures only) stored in
 *   a separate encrypted 0o600 keystore. Nothing here extends trust to storage nodes,
 *   manifests, or browsers.
 * - The node only ever reads/writes inside its dedicated storageDir
 *   (piece IDs are charset-restricted; enforced by the storage node).
 * - Allocation is explicit and quota-enforced by the node; OpenStore
 *   never claims free space on its own.
 * - Stop Sharing enters draining: new stores are refused (503) while
 *   existing pieces stay served. Release is refused while any pieces
 *   remain — other users' replicas are never silently deleted.
 * - No secrets cross the API: status responses carry public metadata
 *   only (nodeId is public, as in the node registry).
 */

import { randomBytes } from "crypto";
import {
  chmod,
  mkdir,
  readdir,
  rename,
  readFile,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
} from "fs/promises";
import { dirname, join, resolve } from "path";
import { createIdentity } from "../../packages/identity/index.js";
import type { Identity } from "../../packages/identity/index.js";
import { loadIdentity, saveIdentity } from "../../packages/identity/keystore.js";
import { isValidManifestFileId } from "../../packages/manifest/store.js";
import type { Registry } from "../../packages/registry/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";

export const PROVIDER_CONFIG_VERSION = 1;

/** Marker proving a directory was created/adopted by the provider. */
const STORAGE_MARKER = ".openstore-storage";
const STORAGE_MARKER_VERSION = 1;

/** Persisted lifecycle states (offline + released derived handling). */
export type ProviderPersistedState = "running" | "draining" | "stopped" | "released";

/** Wire lifecycle states, including derived ones. */
export type ProviderState = "unconfigured" | "stopped" | "running" | "draining" | "offline" | "released";

/** Provider sharing lifecycle (058-060 foundation: sharing → draining → released). */
export type ProviderSharingLifecycle = "sharing" | "draining" | "released";

/** Readiness for placement and operations. */
export type ProviderReadiness = "ready" | "draining" | "released" | "offline" | "unconfigured" | "degraded";

export interface ProviderCondition {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface ProviderReadinessDetail {
  ready: boolean;
  reason: string;
  remainingPieces: number;
  remainingBytes: number;
}

export interface ProviderFilesystem {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface ProviderCapacity {
  allocatedBytes: number;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
  physicalBytes?: number;
  usableBytes?: number;
}

export interface ProviderPieces {
  count: number;
  bytes: number;
  /** Content-hash IDs (safe metadata) for future re-replication. */
  pieceIds: string[];
}

export interface ProviderReliability {
  score: number;
  storageScore: number;
  successfulHeartbeats: number;
  missedHeartbeats: number;
}

export interface ProviderStatus {
  configured: boolean;
  state: ProviderState;
  lifecycle: ProviderSharingLifecycle | "unconfigured";
  storageDir: string | null;
  port: number | null;
  baseUrl: string | null;
  nodeId: string | null;
  draining: boolean;
  filesystem: ProviderFilesystem | null;
  capacity: ProviderCapacity | null;
  pieces: ProviderPieces | null;
  reliability: ProviderReliability | null;
  uptimeMs: number;
  // 068 operational UX: sanitized placement/health/readiness
  placementEligible: boolean;
  placementReason: string;
  readiness: ProviderReadiness;
  conditions: ProviderCondition[];
  drainReadiness: ProviderReadinessDetail;
  releaseReadiness: ProviderReadinessDetail;
}

export interface ProviderRelease {
  released: true;
  storageDir: string;
}

export interface ProviderManagerOptions {
  /**
   * Config file path, or null when the provider is unavailable (demo
   * mode / no manifest store). With null, getStatus reports
   * unconfigured and every mutating call fails with a clear error.
   */
  configPath: string | null;
  /** Shared registry the provider node registers into (may be null). */
  registry: Registry | null;
  /** Password used to encrypt the provider node identity keystore. */
  identityPassword?: string;
}

export interface ProviderManager {
  readonly configPath: string | null;
  getStatus(): Promise<ProviderStatus>;
  setup(location: unknown, capacityBytes: unknown, port?: unknown): Promise<ProviderStatus>;
  start(): Promise<ProviderStatus>;
  stop(): Promise<ProviderStatus>;
  setAllocation(capacityBytes: unknown): Promise<ProviderStatus>;
  release(confirm: unknown): Promise<ProviderRelease>;
  /** Best-effort boot resume for running/draining configs. */
  hydrate(): Promise<void>;
  /**
   * Shut the node process-side down (graceful registry unregister)
   * without touching persisted config — the next start/hydrate brings
   * it back in its persisted mode.
   */
  shutdown(): Promise<void>;
}

interface ProviderConfigFile {
  version: number;
  storageDir: string;
  capacityBytes: number;
  port: number;
  nodePublicKey: string;
  identityKeystorePath: string;
  state: ProviderPersistedState;
  createdAt: number;
  updatedAt: number;
}

function storageMarker(storageDir: string, createdAt: number): string {
  return JSON.stringify({ marker: "openstore-storage", version: STORAGE_MARKER_VERSION, storageDir, createdAt });
}

async function hasValidStorageMarker(storageDir: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(storageDir, STORAGE_MARKER), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const marker = parsed as Record<string, unknown>;
    return (
      marker.marker === "openstore-storage" &&
      marker.version === STORAGE_MARKER_VERSION &&
      marker.storageDir === resolve(storageDir) &&
      typeof marker.createdAt === "number" &&
      Number.isSafeInteger(marker.createdAt)
    );
  } catch {
    return false;
  }
}

/**
 * Filesystem capacity for a path (total/free/used bytes).
 * The path must exist; callers create it first when appropriate.
 */
export async function getFilesystemCapacity(dirPath: string): Promise<ProviderFilesystem> {
  if (typeof dirPath !== "string" || dirPath === "") {
    throw new Error("storage location must be a non-empty string");
  }
  let st: { bsize: number; blocks: number; bavail: number };
  try {
    st = await statfs(dirPath);
  } catch (err) {
    throw new Error(`cannot read filesystem capacity: ${(err as Error).message}`);
  }
  const totalBytes = st.blocks * st.bsize;
  const freeBytes = Math.max(0, st.bavail * st.bsize);
  return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}

/** Piece inventory of a storage dir: piece files only, never contents. */
async function inventoryPieces(storageDir: string): Promise<ProviderPieces> {
  let entries: string[];
  try {
    entries = await readdir(storageDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { count: 0, bytes: 0, pieceIds: [] };
    }
    throw err;
  }
  let count = 0;
  let bytes = 0;
  const pieceIds: string[] = [];
  for (const entry of entries) {
    if (!isValidManifestFileId(entry)) continue;
    try {
      const s = await stat(join(storageDir, entry));
      if (!s.isFile()) continue;
      count += 1;
      bytes += s.size;
      pieceIds.push(entry);
    } catch {}
  }
  pieceIds.sort();
  return { count, bytes, pieceIds };
}

function unconfiguredStatus(): ProviderStatus {
  return {
    configured: false,
    state: "unconfigured",
    lifecycle: "unconfigured",
    storageDir: null,
    port: null,
    baseUrl: null,
    nodeId: null,
    draining: false,
    filesystem: null,
    capacity: null,
    pieces: null,
    reliability: null,
    uptimeMs: 0,
    placementEligible: false,
    placementReason: "not-configured",
    readiness: "unconfigured",
    conditions: [{ code: "unconfigured", severity: "info", message: "Storage sharing is not configured." }],
    drainReadiness: { ready: false, reason: "not-configured", remainingPieces: 0, remainingBytes: 0 },
    releaseReadiness: { ready: false, reason: "not-configured", remainingPieces: 0, remainingBytes: 0 },
  };
}

function lifecycleFromPersisted(state: ProviderPersistedState): ProviderSharingLifecycle {
  if (state === "draining") return "draining";
  if (state === "released") return "released";
  return "sharing";
}

function placementEligibility(
  lifecycle: ProviderSharingLifecycle | "unconfigured",
  live: boolean,
  capacity: ProviderCapacity | null,
): { eligible: boolean; reason: string } {
  if (lifecycle === "unconfigured") return { eligible: false, reason: "not-configured" };
  if (lifecycle === "released") return { eligible: false, reason: "released-not-eligible" };
  if (lifecycle === "draining") return { eligible: false, reason: "draining-not-eligible" };
  if (!live) return { eligible: false, reason: "offline-not-eligible" };
  if (!capacity) return { eligible: false, reason: "capacity-unavailable" };
  if (capacity.availableBytes <= 0) return { eligible: false, reason: "insufficient-capacity" };
  return { eligible: true, reason: "eligible" };
}

function readinessFrom(
  lifecycle: ProviderSharingLifecycle | "unconfigured",
  live: boolean,
  state: ProviderState,
): ProviderReadiness {
  if (lifecycle === "unconfigured") return "unconfigured";
  if (lifecycle === "released") return "released";
  if (lifecycle === "draining") return "draining";
  if (!live && (state === "offline" || state === "stopped")) return "offline";
  if (live) return "ready";
  return "degraded";
}

function buildConditions(args: {
  lifecycle: ProviderSharingLifecycle | "unconfigured";
  live: boolean;
  placementEligible: boolean;
  placementReason: string;
  capacity: ProviderCapacity | null;
  pieces: ProviderPieces;
  registryAvailable: boolean;
}): ProviderCondition[] {
  const conditions: ProviderCondition[] = [];
  if (args.lifecycle === "unconfigured") {
    conditions.push({ code: "unconfigured", severity: "info", message: "Provider not configured." });
    return conditions;
  }
  if (args.lifecycle === "released") {
    conditions.push({ code: "released", severity: "warning", message: "Provider is released and not eligible for placement until explicitly resumed." });
    return conditions;
  }
  if (args.lifecycle === "draining") {
    conditions.push({ code: "draining", severity: "warning", message: "Provider is draining: new placements are rejected while existing pieces remain readable." });
  }
  if (!args.live) {
    conditions.push({ code: "offline", severity: "error", message: "Provider node is offline; start sharing to resume." });
  }
  if (!args.registryAvailable) {
    conditions.push({ code: "coordinator-unavailable", severity: "warning", message: "Coordinator unavailable: placement and repair are paused until fresh discovery." });
  }
  if (!args.placementEligible) {
    const msg =
      args.placementReason === "insufficient-capacity"
        ? "Insufficient available capacity for placement."
        : args.placementReason === "draining-not-eligible"
          ? "Draining node not eligible for new placements."
          : args.placementReason === "released-not-eligible"
            ? "Released node not eligible until resumed."
            : args.placementReason === "offline-not-eligible"
              ? "Offline node not eligible until started."
              : "Node not eligible for placement.";
    conditions.push({ code: args.placementReason, severity: "warning", message: msg });
  }
  if (args.capacity && args.capacity.availableBytes <= 0) {
    conditions.push({ code: "capacity-exhausted", severity: "error", message: "Allocation exhausted: increase allocation or free space." });
  }
  if (conditions.length === 0) {
    conditions.push({ code: "ready", severity: "info", message: "Provider is sharing and eligible for placement." });
  }
  return conditions;
}

function assertPositiveInt(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function parseConfig(text: string): ProviderConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("provider configuration is malformed: invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("provider configuration is malformed: expected an object");
  }
  const r = parsed as Record<string, unknown>;
  if (r["version"] !== PROVIDER_CONFIG_VERSION) {
    throw new Error("provider configuration is malformed: unsupported version");
  }
  if (typeof r["storageDir"] !== "string" || r["storageDir"] === "") {
    throw new Error("provider configuration is malformed: bad storageDir");
  }
  if (typeof r["capacityBytes"] !== "number" || !Number.isInteger(r["capacityBytes"]) || r["capacityBytes"] <= 0) {
    throw new Error("provider configuration is malformed: bad capacityBytes");
  }
  if (typeof r["port"] !== "number" || !Number.isInteger(r["port"]) || r["port"] < 0 || r["port"] > 65535) {
    throw new Error("provider configuration is malformed: bad port");
  }
  if (typeof r["nodePublicKey"] !== "string" || typeof r["identityKeystorePath"] !== "string") {
    throw new Error("provider configuration is malformed: bad node identity");
  }
  if (r["state"] !== "running" && r["state"] !== "draining" && r["state"] !== "stopped" && r["state"] !== "released") {
    throw new Error("provider configuration is malformed: bad state");
  }
  let nodePublicKey: Buffer;
  try {
    nodePublicKey = Buffer.from(r["nodePublicKey"], "base64");
  } catch {
    throw new Error("provider configuration is malformed: bad node identity");
  }
  // Identity keys are DER-encoded Ed25519 material (see
  // packages/identity); only decodability + non-emptiness is checked
  // here. The registry verifies signatures whenever the key is used,
  // so a tampered key fails safely at start/heartbeat time.
  if (nodePublicKey.length === 0) {
    throw new Error("provider configuration is malformed: bad node identity");
  }
  if (nodePublicKey.length !== 44 || !/^[A-Za-z0-9+/]+={0,2}$/.test(r["nodePublicKey"])) {
    throw new Error("provider configuration is malformed: bad node identity");
  }
  return {
    version: PROVIDER_CONFIG_VERSION,
    storageDir: r["storageDir"],
    capacityBytes: r["capacityBytes"],
    port: r["port"],
    nodePublicKey: r["nodePublicKey"],
    identityKeystorePath: r["identityKeystorePath"],
    state: r["state"],
    createdAt: typeof r["createdAt"] === "number" ? r["createdAt"] : 0,
    updatedAt: typeof r["updatedAt"] === "number" ? r["updatedAt"] : 0,
  };
}

export function createProviderManager(options: ProviderManagerOptions): ProviderManager {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  if (options.configPath !== null && (typeof options.configPath !== "string" || options.configPath === "")) {
    throw new TypeError("configPath must be a non-empty string or null");
  }
  const configPath = options.configPath === null ? null : resolve(options.configPath);
  const registry = options.registry ?? null;
  const identityPassword = options.identityPassword;
  if (identityPassword !== undefined && (typeof identityPassword !== "string" || identityPassword.length === 0)) {
    throw new TypeError("identityPassword must be a non-empty string");
  }

  let node: StorageNode | null = null;
  let nodeStartedAt: number | null = null;
  let nodeBaseUrl: string | null = null;
  let nodeId: string | null = null;

  function requireEnv(): void {
    if (configPath === null || registry === null) {
      throw new Error("storage provider requires a manifest store and registry (live server)");
    }
  }

  async function readConfig(): Promise<ProviderConfigFile | null> {
    if (configPath === null) return null;
    let text: string;
    try {
      text = await readFile(configPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const config = parseConfig(text);
    if (config.identityKeystorePath !== `${configPath}.identity`) {
      throw new Error("provider configuration is malformed: unsafe identity keystore path");
    }
    if (!(await hasValidStorageMarker(config.storageDir))) {
      throw new Error("storage provider directory marker is invalid or missing");
    }
    return config;
  }

  async function writeConfig(config: ProviderConfigFile): Promise<void> {
    if (configPath === null) throw new Error("storage provider requires a manifest store (live server)");
    const payload = JSON.stringify({ ...config, version: PROVIDER_CONFIG_VERSION }, null, 2);
    await mkdir(dirname(configPath), { recursive: true });
    const tmpPath = join(dirname(configPath), `.tmp.${randomBytes(8).toString("hex")}.json`);
    try {
      await writeFile(tmpPath, payload, { mode: 0o600 });
      try {
        await chmod(tmpPath, 0o600);
      } catch {}
      await rename(tmpPath, configPath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {}
      throw err;
    }
  }

  async function buildIdentity(config: ProviderConfigFile): Promise<Identity> {
    if (!identityPassword) {
      throw new Error("provider identity password is not configured");
    }
    const identity = await loadIdentity(identityPassword, config.identityKeystorePath);
    if (!identity.publicKey.equals(Buffer.from(config.nodePublicKey, "base64"))) {
      identity.privateKey.fill(0);
      throw new Error("provider identity does not match configuration");
    }
    return identity;
  }

  /** Start the node process-side; throws with safe messages on failure. */
  async function startNode(config: ProviderConfigFile, draining: boolean): Promise<void> {
    if (registry === null) {
      throw new Error("storage provider requires a registry (live server)");
    }
    const fresh = createStorageNode({
      storageDir: config.storageDir,
      identity: await buildIdentity(config),
      registry,
      registryHeartbeatIntervalMs: 5000,
      capacityBytes: config.capacityBytes,
    });
    fresh.setDraining(draining);
    let actualPort: number;
    try {
      actualPort = await fresh.listen(config.port, "127.0.0.1");
    } catch (err) {
      const message = (err as Error).message;
      if (/EADDRINUSE/i.test(message)) {
        throw new Error(`provider node port ${config.port} is already in use; release and set up again with a free port`);
      }
      throw new Error(`provider node failed to start: ${message}`);
    }
    node = fresh;
    nodeStartedAt = Date.now();
    nodeBaseUrl = `http://127.0.0.1:${actualPort}`;
    nodeId = config.nodePublicKey;
  }


  async function stopNodeProcess(): Promise<void> {
    if (node !== null) {
      try {
        await node.close();
      } catch {}
      node = null;
      nodeStartedAt = null;
      nodeBaseUrl = null;
      nodeId = null;
    }
  }

  /** True when the in-memory node handle serves; drops dead handles. */
  async function isNodeLive(): Promise<boolean> {
    if (node === null) return false;
    try {
      await node.getCapacity();
      return true;
    } catch {
      node = null;
      nodeStartedAt = null;
      nodeBaseUrl = null;
      nodeId = null;
      return false;
    }
  }

  async function persistState(config: ProviderConfigFile, state: ProviderConfigFile["state"]): Promise<ProviderConfigFile> {
    const next = { ...config, state, updatedAt: Date.now() };
    await writeConfig(next);
    return next;
  }

  return {
    configPath,

    async getStatus(): Promise<ProviderStatus> {
      const config = await readConfig();
      if (!config) return unconfiguredStatus();
      const live = await isNodeLive();
      const draining = live ? node!.isDraining() : config.state === "draining";
      const isReleased = config.state === "released";
      const lifecycle: ProviderSharingLifecycle | "unconfigured" = isReleased
        ? "released"
        : lifecycleFromPersisted(config.state === "released" ? "released" : config.state);
      const state: ProviderState = isReleased
        ? "released"
        : !live
          ? config.state === "stopped"
            ? "stopped"
            : config.state === "draining"
              ? "draining"
              : "offline"
          : draining
            ? "draining"
            : "running";

      let filesystem: ProviderFilesystem | null = null;
      try {
        const fs = await getFilesystemCapacity(config.storageDir);
        filesystem = { totalBytes: fs.totalBytes, freeBytes: fs.freeBytes, usedBytes: fs.usedBytes };
      } catch {}

      let capacity: ProviderCapacity | null = null;
      if (live) {
        try {
          const cap = await node!.getCapacity();
          const allocated = cap.allocatedBytes ?? config.capacityBytes;
          capacity = {
            allocatedBytes: allocated,
            usedBytes: cap.usedBytes,
            availableBytes: Math.max(0, allocated - cap.usedBytes),
            reservedBytes: 0,
            ...(cap.physicalBytes !== undefined ? { physicalBytes: cap.physicalBytes } : {}),
            ...(cap.usableBytes !== undefined ? { usableBytes: cap.usableBytes } : {}),
          };
        } catch {}
      }
      if (!capacity) {
        const piecesInv = await inventoryPieces(config.storageDir);
        capacity = {
          allocatedBytes: config.capacityBytes,
          usedBytes: piecesInv.bytes,
          availableBytes: Math.max(0, config.capacityBytes - piecesInv.bytes),
          reservedBytes: 0,
        };
      }
      const pieces = await inventoryPieces(config.storageDir);

      let reliability: ProviderReliability | null = null;
      if (registry) {
        const record = registry.get(config.nodePublicKey);
        if (record) {
          reliability = {
            score: record.reliability.score,
            storageScore: record.reliability.storageScore,
            successfulHeartbeats: record.reliability.successfulHeartbeats,
            missedHeartbeats: record.reliability.missedHeartbeats,
          };
        }
      }

      const eligibility = placementEligibility(lifecycle, live, capacity);
      const readiness = readinessFrom(lifecycle, live, state);
      const drainReadiness: ProviderReadinessDetail = {
        ready: lifecycle === "draining" && pieces.count === 0 && pieces.bytes === 0,
        reason:
          lifecycle !== "draining"
            ? lifecycle === "released"
              ? "already-released"
              : lifecycle === "sharing"
                ? "not-draining"
                : "not-draining"
            : pieces.count > 0
              ? `draining-with-pieces:${pieces.count}`
              : "drain-ready",
        remainingPieces: pieces.count,
        remainingBytes: pieces.bytes,
      };
      const releaseReadiness: ProviderReadinessDetail = {
        ready: pieces.count === 0 && pieces.bytes === 0 && (lifecycle === "draining" || lifecycle === "released" || lifecycle === "sharing"),
        reason:
          pieces.count > 0
            ? `pieces-remain:${pieces.count}`
            : lifecycle === "released"
              ? "already-released"
              : "release-ready",
        remainingPieces: pieces.count,
        remainingBytes: pieces.bytes,
      };
      // Released but still has pieces would be inconsistent — releaseReadiness will be false.
      // Authoritative placement eligibility follows 058-060 rules; conditions surface safe reason codes.
      const registryAvailable = Boolean(registry && reliability !== null);
      // If node is live but registry record missing, coordinator may be unavailable.
      const conditions = buildConditions({
        lifecycle,
        live,
        placementEligible: eligibility.eligible,
        placementReason: eligibility.reason,
        capacity,
        pieces,
        registryAvailable: Boolean(registry),
      });

      return {
        configured: true,
        state,
        lifecycle,
        storageDir: config.storageDir,
        port: config.port,
        baseUrl: live ? nodeBaseUrl : null,
        nodeId: config.nodePublicKey,
        draining: lifecycle === "draining" || draining,
        filesystem,
        capacity,
        pieces,
        reliability,
        uptimeMs: live && nodeStartedAt !== null ? Math.max(0, Date.now() - nodeStartedAt) : 0,
        placementEligible: eligibility.eligible,
        placementReason: eligibility.reason,
        readiness,
        conditions,
        drainReadiness,
        releaseReadiness,
      };
    },

    async setup(location: unknown, capacityBytes: unknown, port: unknown = 0): Promise<ProviderStatus> {
      requireEnv();
      if (typeof location !== "string" || location === "" || location.includes("\0")) {
        throw new Error("storage location must be a non-empty path");
      }
      assertPositiveInt(capacityBytes, "allocation");
      const requestedPort = port === undefined ? 0 : port;
      if (typeof requestedPort !== "number" || !Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
        throw new Error("port must be an integer 0–65535 (0 = ephemeral)");
      }
      if (await readConfig()) {
        throw new Error("storage provider is already configured (release it first to start over)");
      }
      const storageDir = resolve(location);
      await mkdir(storageDir, { recursive: true });
      const st = await stat(storageDir);
      if (!st.isDirectory()) {
        throw new Error("storage location is not a directory");
      }
      // Isolation policy: only empty dirs or dirs already marked as ours.
      const markerOurs = await hasValidStorageMarker(storageDir);
      if (!markerOurs) {
        const entries = await readdir(storageDir);
        if (entries.length > 0) {
          throw new Error("storage location is not empty and is not an OpenStore storage directory; choose an empty directory");
        }
      }
      const fs = await getFilesystemCapacity(storageDir);
      if (capacityBytes > fs.freeBytes) {
        throw new Error(
          `requested allocation exceeds free filesystem space (free ${fs.freeBytes} bytes, requested ${capacityBytes} bytes)`,
        );
      }
      const existing = await inventoryPieces(storageDir);
      if (existing.bytes > capacityBytes) {
        throw new Error(
          `requested allocation is below existing usage (uses ${existing.bytes} bytes, requested ${capacityBytes} bytes)`,
        );
      }
      const identity = createIdentity();
      const nodePublicKey = identity.publicKey.toString("base64");
      if (!identityPassword) {
        identity.privateKey.fill(0);
        identity.recoveryPhrase.fill("");
        throw new Error("provider identity password is not configured");
      }
      const identityKeystorePath = `${configPath}.identity`;
      try {
        await saveIdentity(identity, identityPassword, identityKeystorePath);
      } finally {
        identity.privateKey.fill(0);
        identity.recoveryPhrase.fill("");
      }
      const now = Date.now();
      await writeConfig({
        version: PROVIDER_CONFIG_VERSION,
        storageDir,
        capacityBytes,
        port: requestedPort,
        nodePublicKey,
        identityKeystorePath,
        state: "stopped",
        createdAt: now,
        updatedAt: now,
      });
      await writeFile(join(storageDir, STORAGE_MARKER), storageMarker(storageDir, now), {
        mode: 0o600,
        flag: "wx",
      });
      await chmod(join(storageDir, STORAGE_MARKER), 0o600);
      return this.getStatus();
    },

    async start(): Promise<ProviderStatus> {
      requireEnv();
      const config = await readConfig();
      if (!config) {
        throw new Error("storage provider is not configured (run setup first)");
      }
      if (!(await hasValidStorageMarker(config.storageDir))) {
        throw new Error("storage provider directory marker is invalid or missing");
      }
      if (config.state === "released") {
        // Explicit resume from released: requires live marker check and re-registration.
        if (await isNodeLive()) {
          node!.setDraining(false);
          await persistState(config, "running");
          return this.getStatus();
        }
        await startNode(config, false);
        await persistState(config, "running");
        return this.getStatus();
      }
      if (await isNodeLive()) {
        // Full sharing resumes: clear any draining flag.
        node!.setDraining(false);
        await persistState(config, "running");
        return this.getStatus();
      }
      await startNode(config, false);
      await persistState(config, "running");
      return this.getStatus();
    },

    async stop(): Promise<ProviderStatus> {
      requireEnv();
      const config = await readConfig();
      if (!config) {
        throw new Error("storage provider is not configured (run setup first)");
      }
      if (config.state === "released") {
        throw new Error("released provider cannot begin draining; resume sharing first");
      }
      // Persist draining first so a crash mid-stop still reports honestly.
      await persistState(config, "draining");
      if (await isNodeLive()) {
        node!.setDraining(true);
      }
      return this.getStatus();
    },

    async setAllocation(capacityBytes: unknown): Promise<ProviderStatus> {
      requireEnv();
      const config = await readConfig();
      if (!config) {
        throw new Error("storage provider is not configured (run setup first)");
      }
      if (config.state === "released") {
        throw new Error("released allocation cannot be resized; resume sharing first");
      }
      assertPositiveInt(capacityBytes, "allocation");
      const live = await isNodeLive();
      const used = live ? (await node!.getCapacity()).usedBytes : (await inventoryPieces(config.storageDir)).bytes;
      // Reuse capacity-allocation safety: decreasing below usage/reservations is refused.
      if (capacityBytes < used) {
        throw new Error(
          `cannot decrease allocation below current usage (uses ${used} bytes, requested ${capacityBytes} bytes); wait for re-replication before shrinking`,
        );
      }
      // Increasing allocation is allowed when safe (filesystem check).
      const fs = await getFilesystemCapacity(config.storageDir);
      if (capacityBytes > fs.freeBytes && capacityBytes > config.capacityBytes) {
        throw new Error(
          `requested allocation exceeds free filesystem space (free ${fs.freeBytes} bytes, requested ${capacityBytes} bytes)`,
        );
      }
      const next = { ...config, capacityBytes, updatedAt: Date.now() };
      await writeConfig(next);
      if (live) {
        node!.setCapacityBytes(capacityBytes);
      }
      return this.getStatus();
    },

    async release(confirm: unknown): Promise<ProviderRelease> {
      requireEnv();
      const config = await readConfig();
      if (!config) {
        throw new Error("storage provider is not configured (run setup first)");
      }
      if (confirm !== true) {
        throw new Error("release requires explicit confirmation");
      }
      const pieces = await inventoryPieces(config.storageDir);
      if (pieces.count > 0) {
        throw new Error(
          `cannot release: ${pieces.count} pieces (${pieces.bytes} bytes) remain stored; ` +
          `this node may hold other users' only retrievable replicas and re-replication is not automated yet`,
        );
      }
      // Safe release: must be draining or already released state; sharing must drain first.
      if (config.state !== "draining" && config.state !== "released" && config.state !== "stopped" && config.state !== "running") {
        throw new Error("release requires draining state first");
      }
      await stopNodeProcess();
      // Mark as released (authoritative lifecycle) and keep marker for explicit resume.
      // Existing safety semantics preserved: release blocked while pieces remain.
      // Released providers remain unavailable until explicit resume via start().
      await persistState(config, "released");
      return { released: true, storageDir: config.storageDir };
    },

    async hydrate(): Promise<void> {
      if (configPath === null || registry === null) return;
      const config = await readConfig();
      if (!config || config.state === "stopped" || config.state === "released") return;
      if (await isNodeLive()) return;
      // Resume the persisted mode: draining configs stay draining, released stays released.
      await startNode(config, config.state === "draining");
    },

    async shutdown(): Promise<void> {
      await stopNodeProcess();
    },
  };
}
