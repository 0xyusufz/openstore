/**
 * Client-side adapter for the registry coordinator (Milestone 042).
 *
 * The coordinator is deliberately treated as untrusted input. A failed
 * refresh never replaces the last known-good snapshot.
 */
import type { CoordinatorEndpointProvider, StorageNodeEndpoint } from "./index.js";
import type { FileManifest, ManifestChunk } from "../../packages/manifest/index.js";
import { multiaddr } from "@multiformats/multiaddr";
import { peerIdFromOpenStorePublicKey } from "../../packages/p2p/identity-binding.js";
import { createRegistryClient, type RegistryClientErrorClassification } from "../../packages/registry/coordinator.js";

export interface CoordinatorAdapterOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CoordinatorAdapter extends CoordinatorEndpointProvider {
  readonly lastError: Error | undefined;
  readonly lastRefreshAt: number | undefined;
  readonly metadata: CoordinatorMetadata;
  /** A non-throwing snapshot suitable for best-effort callers. */
  refreshSafe(): Promise<StorageNodeEndpoint[]>;
  getKnownEndpoints(): StorageNodeEndpoint[];
}
export interface CoordinatorMetadata {
  lastKnownGoodAt?: number;
  lastKnownGoodCount: number;
  lastError?: string;
  lastErrorClassification?: RegistryClientErrorClassification;
  consecutiveFailureCount: number;
  readonly snapshotAge: number | undefined;
  readonly isStale: boolean;
}

/** Resolve explicit endpoints first; discover only when none were supplied. */
export async function resolveEndpoints(
  endpoints: StorageNodeEndpoint[],
  provider?: CoordinatorEndpointProvider,
  options: { requireFresh?: boolean } = {},
): Promise<StorageNodeEndpoint[]> {
  if (!provider) return endpoints;
  if (options.requireFresh || endpoints.length === 0) return provider.refresh();
  return endpoints;
}

/** Resolve only replicas recorded in a manifest; never invents replacements. */
export function resolveManifestReplicaEndpoints(
  manifest: Pick<FileManifest, "chunks" | "nodeIds">,
  endpoints: StorageNodeEndpoint[],
  chunk?: Pick<ManifestChunk, "nodeIds">,
): StorageNodeEndpoint[] {
  if (!Array.isArray(endpoints)) throw new TypeError("endpoints must be an array");
  const ids = chunk?.nodeIds ?? manifest.nodeIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("manifest has no known replica identities");
  const byId = new Map<string, StorageNodeEndpoint>();
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint.id !== "string" || endpoint.id.length === 0) {
      throw new TypeError("manifest replica endpoint has invalid identity");
    }
    if (byId.has(endpoint.id)) throw new TypeError(`duplicate endpoint identity: ${endpoint.id}`);
    byId.set(endpoint.id, endpoint);
  }
  const result: StorageNodeEndpoint[] = [];
  for (const id of ids) {
    const endpoint = byId.get(id);
    if (endpoint) result.push(endpoint);
  }
  return result;
}

export function coordinatorNodesToEndpoints(payload: unknown): StorageNodeEndpoint[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("coordinator response must be an object");
  }
  const nodes = (payload as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) throw new TypeError("coordinator response nodes must be an array");
  const endpoints = nodes.map((node, index) => nodeToEndpoint(node, index));
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.id)) throw new TypeError(`duplicate coordinator node identity: ${endpoint.id}`);
    seen.add(endpoint.id);
  }
  return endpoints.filter((_endpoint, index) => (nodes[index] as Record<string, unknown>).available === true);
}

export function createCoordinatorAdapter(options: CoordinatorAdapterOptions): CoordinatorAdapter {
  if (!options || typeof options.baseUrl !== "string" || options.baseUrl.trim() === "") {
    throw new TypeError("coordinator baseUrl must be a non-empty string");
  }
  const request = options.fetch;
  const nativeClient = request === undefined
    ? createRegistryClient({ baseUrl: options.baseUrl, token: options.token })
    : undefined;
  let snapshot: StorageNodeEndpoint[] = [];
  let knownSnapshot: StorageNodeEndpoint[] = [];
  let lastError: Error | undefined;
  let lastRefreshAt: number | undefined;
  let inFlight: Promise<StorageNodeEndpoint[]> | undefined;
  let metadata: CoordinatorMetadata = { lastKnownGoodCount: 0, consecutiveFailureCount: 0, snapshotAge: undefined, isStale: false };
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const refresh = (): Promise<StorageNodeEndpoint[]> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const rawNodes = nativeClient
        ? await nativeClient.nodes()
        : await fetchRawNodes(request!, `${baseUrl}/v1/nodes`, options.token);
      knownSnapshot = endpointsForNodes(rawNodes);
      const endpoints = knownSnapshot.filter((_endpoint, index) => (rawNodes[index] as Record<string, unknown>).available === true);
      snapshot = endpoints;
      lastError = undefined;
      lastRefreshAt = Date.now();
      metadata = { lastKnownGoodAt: lastRefreshAt, lastKnownGoodCount: snapshot.length, consecutiveFailureCount: 0, snapshotAge: 0, isStale: false };
      return snapshot.slice();
    })().catch((error: unknown) => {
      lastError = error instanceof Error ? error : new Error(String(error));
      const classification = (error as { classification?: RegistryClientErrorClassification }).classification;
      metadata = { ...metadata, lastError: lastError.message.slice(0, 300), lastErrorClassification: classification ?? "unknown", consecutiveFailureCount: metadata.consecutiveFailureCount + 1 };
      throw lastError;
    }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    get lastError() { return lastError; },
    get lastRefreshAt() { return lastRefreshAt; },
    get metadata() {
      const snapshotAge = metadata.lastKnownGoodAt === undefined ? undefined : Math.max(0, Date.now() - metadata.lastKnownGoodAt);
      return { ...metadata, snapshotAge, isStale: metadata.consecutiveFailureCount > 0 };
    },
    getEndpoints: () => snapshot.slice(),
    getKnownEndpoints: () => knownSnapshot.slice(),
    refresh,
    async refreshSafe() {
      try { return await refresh(); } catch { return snapshot.slice(); }
    },
  };
}

async function fetchRawNodes(request: NonNullable<CoordinatorAdapterOptions["fetch"]>, url: string, token?: string): Promise<unknown[]> {
  const response = await request(url, { headers: { accept: "application/json", ...(token ? { authorization: "Bearer " + token } : {}) } });
  if (!response.ok) throw new Error(`coordinator returned ${response.status}`);
  const payload = await response.json() as { nodes?: unknown[] };
  if (!Array.isArray(payload.nodes)) throw new TypeError("coordinator response nodes must be an array");
  return payload.nodes;
}

function endpointsForNodes(nodes: unknown[]): StorageNodeEndpoint[] {
  return nodes.map((node, index) => nodeToEndpoint(node, index));
}

function nodeToEndpoint(value: unknown, index: number): StorageNodeEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`coordinator node[${index}] must be an object`);
  }
  const node = value as Record<string, unknown>;
  rejectSensitive(node, `node[${index}]`);
  const id = requiredString(node.nodeId, `node[${index}].nodeId`);
  const publicKey = requiredString(node.publicKey, `node[${index}].publicKey`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey) || Buffer.from(publicKey, "base64").length !== 44) {
    throw new TypeError(`node[${index}].publicKey is invalid`);
  }
  const baseUrl = requiredString(node.baseUrl, `node[${index}].baseUrl`);
  if (typeof node.available !== "boolean") throw new TypeError(`node[${index}].available must be boolean`);
  const transport = node.transport === undefined ? inferTransport(baseUrl) : node.transport;
  if (transport !== "http" && transport !== "libp2p") throw new TypeError(`node[${index}].transport is invalid`);
  if (transport === "http" && !/^https?:\/\//.test(baseUrl)) throw new TypeError(`node[${index}] HTTP baseUrl is invalid`);
  if (transport === "libp2p" && !/^libp2p:\/\//.test(baseUrl)) throw new TypeError(`node[${index}] libp2p baseUrl is invalid`);
  const capacity = validateCapacity(node.capacity, index);
  const reliability = validateReliability(node.reliability, index);
  const result: StorageNodeEndpoint = {
    id, baseUrl, transport, capacity, reliabilityScore: reliability.score,
    storageScore: reliability.storageScore,
  };
  if (transport === "libp2p") {
    result.multiaddr = requiredString(node.multiaddr, `node[${index}].multiaddr`);
    result.identityBinding = requiredString(node.identityBinding, `node[${index}].identityBinding`);
    result.identity = { publicKey };
    if (result.identityBinding !== id ||
      peerIdFromOpenStorePublicKey(Buffer.from(publicKey, "base64")) !== id) {
      throw new TypeError(`node[${index}] identity binding does not match PeerId`);
    }
    try {
      const address = multiaddr(result.multiaddr);
      const peerId = result.multiaddr.match(/\/p2p\/([^/]+)$/)?.[1];
      if (peerId !== undefined && peerId !== id) throw new Error("multiaddr PeerId mismatch");
      if (address.toString() !== result.multiaddr) throw new Error("malformed multiaddr");
    } catch {
      throw new TypeError(`node[${index}].multiaddr is invalid`);
    }
  }
  if (node.capabilities !== undefined) {
    if (!node.capabilities || typeof node.capabilities !== "object" || Array.isArray(node.capabilities)) {
      throw new TypeError(`node[${index}].capabilities is invalid`);
    }
    const c = node.capabilities as Record<string, unknown>;
    for (const key of ["pieceStore", "pieceGet", "pieceDelete"]) {
      if (typeof c[key] !== "boolean") throw new TypeError(`node[${index}].capabilities.${key} is invalid`);
    }
    if (c.maxPieceBytes !== undefined) safeInteger(c.maxPieceBytes, `node[${index}].capabilities.maxPieceBytes`);
    result.capabilities = { pieceStore: c.pieceStore as boolean, pieceGet: c.pieceGet as boolean, pieceDelete: c.pieceDelete as boolean, ...(c.maxPieceBytes === undefined ? {} : { maxPieceBytes: c.maxPieceBytes as number }) };
  }
  if (transport === "libp2p" && result.capabilities === undefined) {
    throw new TypeError(`node[${index}].capabilities is required for libp2p`);
  }
  return result;
}

function rejectSensitive(value: unknown, path: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["privateKey", "secretKey", "seed", "password", "recoveryPhrase", "mnemonic", "encryptionKey"].includes(key)) {
      throw new TypeError(`${path}.${key} is not allowed`);
    }
    rejectSensitive(child, `${path}.${key}`);
  }
}

async function fetchNodes(
  request: NonNullable<CoordinatorAdapterOptions["fetch"]>,
  url: string,
  token?: string,
): Promise<StorageNodeEndpoint[]> {
  const response = await request(url, {
    headers: {
      accept: "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
  });
  if (!response.ok) throw new Error(`coordinator returned ${response.status}`);
  return coordinatorNodesToEndpoints(await response.json());
}

function inferTransport(baseUrl: string): "http" | "libp2p" {
  if (/^https?:\/\//.test(baseUrl)) return "http";
  if (baseUrl.startsWith("libp2p:")) return "libp2p";
  throw new TypeError("node baseUrl has unsupported transport");
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}
function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value as number;
}
function validateCapacity(value: unknown, index: number): NonNullable<StorageNodeEndpoint["capacity"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`node[${index}].capacity is invalid`);
  const c = value as Record<string, unknown>;
  const result: NonNullable<StorageNodeEndpoint["capacity"]> = { usedBytes: safeInteger(c.usedBytes, `node[${index}].capacity.usedBytes`), availableBytes: safeInteger(c.availableBytes, `node[${index}].capacity.availableBytes`) };
  if (c.allocatedBytes !== undefined) result.allocatedBytes = safeInteger(c.allocatedBytes, `node[${index}].capacity.allocatedBytes`);
  if (c.totalBytes !== undefined) result.totalBytes = safeInteger(c.totalBytes, `node[${index}].capacity.totalBytes`);
  return result;
}
function validateReliability(value: unknown, index: number): { score: number; storageScore: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`node[${index}].reliability is invalid`);
  const r = value as Record<string, unknown>;
  const score = safeInteger(r.score, `node[${index}].reliability.score`);
  const storageScore = safeInteger(r.storageScore, `node[${index}].reliability.storageScore`);
  if (score > 100 || storageScore > 100) throw new TypeError(`node[${index}].reliability score is invalid`);
  return { score, storageScore };
}
