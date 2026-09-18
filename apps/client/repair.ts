import { hashPieceId, buildManifest } from "../../packages/manifest/index.js";
import type { FileManifest, ManifestChunk } from "../../packages/manifest/index.js";
import {
  ManifestConflictError,
  type ManifestStore,
} from "../../packages/manifest/store.js";
import type { CoordinatorEndpointProvider } from "./index.js";
import type { StorageNodeEndpoint } from "./index.js";
import {
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  getPieceFromNodes,
  isTransientError,
  storePieceOnNodes,
} from "./index.js";
import { HttpStorageTransport, MixedStorageTransport } from "./http-transport.js";
import type { P2PNodeAddress, P2PTransport } from "../../packages/p2p/index.js";
import {
  createOperationRecord,
  createOperationRecordStore,
  createPieceClaim,
  createClaimOnNode,
  markClaimReferencedOnNode,
  storeClaimedPieceOnNode,
  type OperationRecordStore,
} from "./provenance.js";
import type { PieceClaim } from "../../packages/provenance/index.js";
import { CoordinatorDiscoveryError } from "./coordinator.js";
import { isPlacementEligibleEndpoint } from "./selection.js";

export type RepairClassification =
  | "coordinator-unavailable"
  | "coordinator-stale"
  | "fresh-coordinator-required"
  | "source-unavailable"
  | "source-corrupt"
  | "target-unavailable"
  | "insufficient-capacity"
  | "manifest-conflict"
  | "cancelled"
  | "failed";

export class RepairError extends Error {
  readonly classification: RepairClassification;
  readonly fileId: string;
  readonly chunkIndex?: number;

  constructor(
    classification: RepairClassification,
    fileId: string,
    message: string,
    chunkIndex?: number,
  ) {
    super(message);
    this.name = "RepairError";
    this.classification = classification;
    this.fileId = fileId;
    this.chunkIndex = chunkIndex;
  }
}

export interface RepairOptions {
  manifestStore: ManifestStore;
  coordinator: CoordinatorEndpointProvider;
  lostNodeId: string;
  chunkIndex?: number;
  timeoutMs?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
  observationCount?: number;
  observationIntervalMs?: number;
  gracePeriodMs?: number;
  maxTargetAttempts?: number;
  maxCasRetries?: number;
  /** Maximum accepted piece response body per replica. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  transport?: P2PTransport;
  identity?: { publicKey: Buffer; privateKey: Buffer };
  operationStore?: OperationRecordStore;
}

export interface RepairedChunk {
  chunkIndex: number;
  pieceId: string;
  removedNodeId: string;
  addedNodeId: string;
  sourceNodeId: string;
}

export interface RepairReport {
  version: 1;
  fileId: string;
  classification: "repaired";
  chunks: RepairedChunk[];
  manifest: FileManifest;
}

const inFlightRepairs = new Map<string, Promise<RepairReport>>();
const MAX_OBSERVATIONS = 5;
const MAX_TARGET_ATTEMPTS = 5;
const MAX_CAS_RETRIES = 3;

export async function repairManifestReplica(
  fileId: string,
  options: RepairOptions,
): Promise<RepairReport> {
  validateOptions(fileId, options);
  const chunkKey = options.chunkIndex === undefined ? "*" : String(options.chunkIndex);
  const key = `${fileId}:${chunkKey}:${options.lostNodeId}`;
  const existing = inFlightRepairs.get(key);
  if (existing) return existing;
  const operation = repairUncoalesced(fileId, options);
  inFlightRepairs.set(key, operation);
  try {
    return await operation;
  } finally {
    if (inFlightRepairs.get(key) === operation) inFlightRepairs.delete(key);
  }
}

async function repairUncoalesced(fileId: string, options: RepairOptions): Promise<RepairReport> {
  const observation = await observeConfirmedLoss(fileId, options);
  const initial = await options.manifestStore.loadWithRevision(fileId);
  if (!initial) throw new RepairError("failed", fileId, "manifest not found");
  const chunks = initial.manifest.chunks.filter((chunk) =>
    chunk.nodeIds.includes(options.lostNodeId) &&
    (options.chunkIndex === undefined || chunk.index === options.chunkIndex),
  );
  if (chunks.length === 0) {
    return {
      version: 1,
      fileId,
      classification: "repaired",
      chunks: [],
      manifest: initial.manifest,
    };
  }

  const repaired: RepairedChunk[] = [];
  let current = initial;
  for (const originalChunk of chunks) {
    checkCancelled(options.signal, fileId, originalChunk.index);
    const result = await repairChunk(fileId, current.manifest, current.revision, originalChunk, observation, options);
    repaired.push(result.repaired);
    current = result.snapshot;
  }
  return {
    version: 1,
    fileId,
    classification: "repaired",
    chunks: repaired,
    manifest: current.manifest,
  };
}

interface LossObservation {
  available: StorageNodeEndpoint[];
  known: StorageNodeEndpoint[];
}

async function observeConfirmedLoss(fileId: string, options: RepairOptions): Promise<LossObservation> {
  const count = boundedInteger(options.observationCount ?? 2, 1, MAX_OBSERVATIONS, "observationCount");
  const interval = boundedInteger(options.observationIntervalMs ?? 100, 0, 60_000, "observationIntervalMs");
  const grace = boundedInteger(options.gracePeriodMs ?? interval, 0, 60_000, "gracePeriodMs");
  let last: LossObservation | undefined;
  for (let attempt = 0; attempt < count; attempt += 1) {
    checkCancelled(options.signal, fileId);
    let available: StorageNodeEndpoint[];
    try {
      available = await options.coordinator.refresh();
    } catch (error) {
      const state = options.coordinator.discovery?.freshness;
      const classification = state === "stale" || state === "cached"
        ? "coordinator-stale"
        : state === "unavailable"
          ? "coordinator-unavailable"
          : "coordinator-unavailable";
      throw new RepairError(classification, fileId, error instanceof CoordinatorDiscoveryError ? error.message : "coordinator unavailable");
    }
    if (options.coordinator.discovery && !options.coordinator.discovery.canRepair) {
      throw new RepairError(
        options.coordinator.discovery.freshness === "stale" || options.coordinator.discovery.freshness === "cached"
          ? "coordinator-stale"
          : "fresh-coordinator-required",
        fileId,
        "fresh coordinator information required",
      );
    }
    const known = options.coordinator.getKnownEndpoints?.() ?? available;
    if (available.some((endpoint) => endpoint.id === options.lostNodeId)) {
      throw new RepairError("failed", fileId, `lost node "${options.lostNodeId}" reappeared; repair aborted`);
    }
    last = { available, known };
    if (attempt + 1 < count) await delayWithCancellation(Math.max(interval, grace), options.signal, fileId);
  }
  return last as LossObservation;
}

async function repairChunk(
  fileId: string,
  manifest: FileManifest,
  revision: number,
  chunk: ManifestChunk,
  observation: LossObservation,
  options: RepairOptions,
): Promise<{ repaired: RepairedChunk; snapshot: { manifest: FileManifest; revision: number } }> {
  const survivingIds = chunk.nodeIds.filter((id) => id !== options.lostNodeId);
  const sourceEndpoints = observation.known.filter((endpoint) => survivingIds.includes(endpoint.id));
  if (sourceEndpoints.length === 0) {
    throw new RepairError("source-unavailable", fileId, `no surviving manifest replica is known for chunk ${chunk.index}`, chunk.index);
  }
  let bytes: Buffer;
  let source: StorageNodeEndpoint;
  try {
    const result = await getPieceFromNodes(chunk.pieceId, sourceEndpoints, {
      timeoutMs: options.timeoutMs,
      retryAttempts: options.retryAttempts,
      retryBackoffMs: options.retryBackoffMs,
      transport: options.transport,
      identity: options.identity,
      ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
      validate: (candidate) => {
        if (hashPieceId(candidate) !== chunk.pieceId) {
          throw new RepairError("source-corrupt", fileId, `source bytes do not match piece ${chunk.pieceId}`, chunk.index);
        }
      },
    });
    bytes = result.bytes;
    source = result.from;
  } catch (error) {
    if (error instanceof RepairError) throw error;
    const message = safeError(error);
    throw new RepairError(
      /hash mismatch|corrupt|integrity|do not match|stored bytes/i.test(message) ? "source-corrupt" : "source-unavailable",
      fileId,
      message,
      chunk.index,
    );
  }

  const targets = selectTargets(observation.available, chunk, options.lostNodeId, bytes.length);
  if (targets.length === 0) {
    const hasCapacityCandidate = observation.available.some((endpoint) =>
      endpoint.id !== options.lostNodeId &&
      !survivingIds.includes(endpoint.id) &&
      endpoint.lifecycle !== "draining" &&
      endpoint.lifecycle !== "released" &&
      endpoint.capabilities?.pieceStore !== false,
    );
    throw new RepairError(
      hasCapacityCandidate ? "insufficient-capacity" : "target-unavailable",
      fileId,
      `no eligible replacement target for chunk ${chunk.index}`,
      chunk.index,
    );
  }

  const transport = options.transport ?? new MixedStorageTransport(new HttpStorageTransport(options.identity));
  let target: StorageNodeEndpoint | undefined;
  let placement: { endpoint: StorageNodeEndpoint; claim: PieceClaim; operationId: string } | undefined;
  const operationStore = options.identity
    ? (options.operationStore ?? createOperationRecordStore(`${options.manifestStore.dir}/.provenance-operations`))
    : undefined;
  const maxTargets = Math.min(options.maxTargetAttempts ?? targets.length, MAX_TARGET_ATTEMPTS);
  for (const candidate of targets.slice(0, maxTargets)) {
    checkCancelled(options.signal, fileId, chunk.index);
    try {
      const candidatePlacement = await ensureTargetPiece(
        candidate, chunk.pieceId, bytes, transport, options, fileId, chunk.index, operationStore, revision,
      );
      target = candidate;
      placement = candidatePlacement;
      break;
    } catch (error) {
      if (error instanceof RepairError && error.classification === "failed") throw error;
    }
  }
  if (!target) {
    throw new RepairError("target-unavailable", fileId, `replacement target failed for chunk ${chunk.index}`, chunk.index);
  }

  let latest = { manifest, revision };
  for (let attempt = 0; attempt < Math.min(options.maxCasRetries ?? MAX_CAS_RETRIES, MAX_CAS_RETRIES); attempt += 1) {
    checkCancelled(options.signal, fileId, chunk.index);
    const nextChunk = {
      ...chunk,
      nodeIds: [...survivingIds, target.id],
    };
    const nextManifest = buildManifest({
      fileId: latest.manifest.fileId,
      filename: latest.manifest.filename,
      size: latest.manifest.size,
      chunkSize: latest.manifest.chunkSize,
      cryptoVersion: latest.manifest.cryptoVersion,
      chunks: latest.manifest.chunks.map((candidate) =>
        candidate.index === chunk.index ? nextChunk : candidate,
      ),
    });
    try {
      const saved = await options.manifestStore.saveIfRevision(fileId, latest.revision, nextManifest);
      if (placement && options.identity && operationStore) {
        await markClaimReferencedOnNode(placement.endpoint, placement.claim.pieceId, placement.claim.claimId, options.identity, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        await operationStore.update(placement.operationId, "committed");
      }
      const savedSnapshot = await options.manifestStore.loadWithRevision(fileId);
      if (!savedSnapshot) throw new Error("manifest disappeared after CAS");
      return {
        repaired: {
          chunkIndex: chunk.index,
          pieceId: chunk.pieceId,
          removedNodeId: options.lostNodeId,
          addedNodeId: target.id,
          sourceNodeId: source.id,
        },
        snapshot: { manifest: savedSnapshot.manifest ?? saved, revision: savedSnapshot.revision },
      };
    } catch (error) {
      if (!(error instanceof ManifestConflictError)) {
        throw new RepairError("failed", fileId, safeError(error), chunk.index);
      }
      const refreshed = await options.manifestStore.loadWithRevision(fileId);
      if (!refreshed) throw new RepairError("manifest-conflict", fileId, "manifest disappeared during repair", chunk.index);
      const currentChunk = refreshed.manifest.chunks[chunk.index];
      if (!currentChunk) throw new RepairError("manifest-conflict", fileId, "repaired chunk disappeared", chunk.index);
      if (currentChunk.nodeIds.includes(target.id) && !currentChunk.nodeIds.includes(options.lostNodeId)) {
        if (placement && options.identity && operationStore) {
          await markClaimReferencedOnNode(placement.endpoint, placement.claim.pieceId, placement.claim.claimId, options.identity, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
          await operationStore.update(placement.operationId, "committed");
        }
        return {
          repaired: { chunkIndex: chunk.index, pieceId: chunk.pieceId, removedNodeId: options.lostNodeId, addedNodeId: target.id, sourceNodeId: source.id },
          snapshot: refreshed,
        };
      }
      if (!currentChunk.nodeIds.includes(options.lostNodeId)) {
        throw new RepairError("manifest-conflict", fileId, "manifest changed without a valid replacement", chunk.index);
      }
      latest = refreshed;
    }
  }
  throw new RepairError("manifest-conflict", fileId, "manifest CAS retries exhausted", chunk.index);
}

function selectTargets(
  endpoints: StorageNodeEndpoint[],
  chunk: ManifestChunk,
  lostNodeId: string,
  pieceSize: number,
): StorageNodeEndpoint[] {
  const existing = new Set(chunk.nodeIds);
  return endpoints
    .filter((endpoint) => !existing.has(endpoint.id) && endpoint.id !== lostNodeId)
    .filter((endpoint) => isPlacementEligibleEndpoint(endpoint, pieceSize, false))
    .filter((endpoint, index, all) => all.findIndex((candidate) => candidate.id === endpoint.id) === index)
    .sort((a, b) => (b.capacity?.availableBytes ?? 0) - (a.capacity?.availableBytes ?? 0));
}

async function ensureTargetPiece(
  target: StorageNodeEndpoint,
  pieceId: string,
  bytes: Buffer,
  transport: P2PTransport,
  options: RepairOptions,
  fileId: string,
  chunkIndex: number,
  operationStore?: OperationRecordStore,
  expectedManifestRevision = 0,
): Promise<{ endpoint: StorageNodeEndpoint; claim: PieceClaim; operationId: string } | undefined> {
  const address = toAddress(target);
  let claim: PieceClaim | undefined;
  let operationId: string | undefined;
  if (options.identity && operationStore) {
    claim = createPieceClaim(pieceId, "repair", options.identity);
    const operation = createOperationRecord(pieceId, claim, target.id, "repair", expectedManifestRevision, fileId);
    operationId = operation.operationId;
    await createClaimOnNode(target, claim, options.identity, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    await operationStore.create(operation);
  }
  const responseOptions = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  };
  try {
    const existing = await transport.getPiece(address, pieceId, responseOptions);
    if (existing.status === 200 && existing.bytes) {
      if (hashPieceId(existing.bytes) !== pieceId) {
        throw new RepairError("failed", fileId, `target "${target.id}" contains bytes inconsistent with ${pieceId}`, chunkIndex);
      }
      if (claim && operationId) {
        await operationStore!.update(operationId, "stored");
        await operationStore!.update(operationId, "verified");
        return { endpoint: target, claim, operationId };
      }
      return undefined;
    }
    if (existing.status !== 404 && existing.status >= 400 && !isTransientStatus(existing.status)) {
      throw new Error(`target returned status ${existing.status}`);
    }
  } catch (error) {
    if (error instanceof RepairError) throw error;
    if (!isTransientError(safeError(error)) && !/404|not found/i.test(safeError(error))) throw error;
  }
  if (claim && operationId && options.identity) {
    await storeClaimedPieceOnNode(target, pieceId, claim.claimId, bytes, options.identity, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    await operationStore!.update(operationId, "stored");
  }
  const report = claim ? { succeeded: [target] } : await storePieceOnNodes(pieceId, bytes, [target], {
    timeoutMs: options.timeoutMs,
    retryAttempts: options.retryAttempts,
    retryBackoffMs: options.retryBackoffMs,
    transport,
    identity: options.identity,
    replicationFactor: 1,
  });
  if (report.succeeded.length !== 1) throw new Error(`target "${target.id}" did not acknowledge piece storage`);
  const readBack = await transport.getPiece(address, pieceId, responseOptions);
  if (readBack.status !== 200 || !readBack.bytes || hashPieceId(readBack.bytes) !== pieceId || !readBack.bytes.equals(bytes)) {
    throw new Error(`target "${target.id}" failed piece read-back verification`);
  }
  if (claim && operationId) {
    await operationStore!.update(operationId, "verified");
    return { endpoint: target, claim, operationId };
  }
  return undefined;
}

function toAddress(endpoint: StorageNodeEndpoint): P2PNodeAddress {
  return {
    nodeId: endpoint.id,
    baseUrl: endpoint.baseUrl,
    ...(endpoint.multiaddr === undefined ? {} : { multiaddr: endpoint.multiaddr }),
    ...(endpoint.identityBinding === undefined ? {} : { identityBinding: endpoint.identityBinding }),
    ...(endpoint.identity === undefined ? {} : { identity: endpoint.identity }),
  };
}

function validateOptions(fileId: string, options: RepairOptions): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new TypeError("fileId is invalid");
  if (!options || !options.manifestStore || !options.coordinator) throw new TypeError("manifestStore and coordinator are required");
  if (typeof options.lostNodeId !== "string" || options.lostNodeId === "") throw new TypeError("lostNodeId is required");
  if (options.chunkIndex !== undefined && (!Number.isSafeInteger(options.chunkIndex) || options.chunkIndex < 0)) throw new TypeError("chunkIndex is invalid");
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} is outside its bounded range`);
  return value;
}

function checkCancelled(signal: AbortSignal | undefined, fileId: string, chunkIndex?: number): void {
  if (signal?.aborted) throw new RepairError("cancelled", fileId, "repair cancelled", chunkIndex);
}

async function delayWithCancellation(ms: number, signal: AbortSignal | undefined, fileId: string): Promise<void> {
  if (ms === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new RepairError("cancelled", fileId, "repair cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s]+/gi, "[endpoint]")
    .replace(/(password|token|secret|private key|recovery phrase|seed|encryption key|dek)(?:\s*[:=]\s*)?[^\s:;,)]*/gi, "$1 [redacted]")
    .slice(0, 300);
}
