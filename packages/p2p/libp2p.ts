import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { mplex } from "@libp2p/mplex";
import { noise } from "@chainsafe/libp2p-noise";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "@libp2p/interface";
import type { P2PNodeCapabilities, P2PNodeIdentity, P2PTransport, P2PTransportRequestOptions, P2PNodeAddress, P2PGetResult, P2PHealthResult, PeerDiscovery, P2PPeerDescriptor, P2PProvenanceTransport } from "./index.js";
import type { DeleteIfUnclaimedResult, PieceClaim } from "../provenance/index.js";
import { validateP2PPeerDescriptor } from "./index.js";
import { createDhtServices, DhtPeerDiscovery } from "./dht-discovery.js";
import { peerIdFromOpenStorePrivateKey, peerIdFromOpenStorePublicKey } from "./identity-binding.js";
import type { Registry } from "../registry/index.js";
import { hashPieceId } from "../manifest/index.js";

export const OPENSTORE_PIECE_PROTOCOL = "/openstore/piece/1.0.0";
export const OPENSTORE_PROVENANCE_PROTOCOL = "/openstore/provenance/1.0.0";
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

interface PieceRequest {
  op: "store" | "get" | "delete" | "health";
  pieceId: string;
  data?: string;
}

interface PieceResponse {
  status: number;
  data?: string;
  error?: string;
}

interface ProvenanceRequest {
  op: "claim-create" | "claim-store" | "claim-reference" | "claim-release" | "claim-reconcile" | "delete-if-unclaimed";
  pieceId?: string;
  claim?: PieceClaim;
  claimId?: string;
  clientNamespace?: string;
  data?: string;
}

export interface Libp2pStorageNodeOptions {
  applicationIdentity: P2PNodeIdentity;
  /** Private identity material stays in process memory and is never serialized. */
  applicationPrivateKey?: Buffer;
  listenAddrs?: string[];
  maxPieceBytes?: number;
  allocatedBytes?: number;
  availableBytes?: number;
  storePiece: (pieceId: string, data: Buffer) => Promise<number>;
  getPiece: (pieceId: string) => Promise<Buffer | null>;
  deletePiece: (pieceId: string) => Promise<number>;
  discovery?: PeerDiscovery;
  discoveryRefreshIntervalMs?: number;
  placementRegistry?: Registry;
  onConnectionEvent?: (event: Libp2pConnectionEvent) => void;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxReconnectAttempts?: number;
  provenance?: {
    createClaim(claim: PieceClaim): Promise<PieceClaim>;
    associatePiece(pieceId: string, claimId: string, writePiece: () => Promise<void>): Promise<void>;
    markReferenced(pieceId: string, claimId: string): Promise<PieceClaim>;
    releaseClaim(pieceId: string, claimId: string, clientNamespace: string): Promise<PieceClaim>;
    reconcile(pieceId: string, claimId: string): Promise<PieceClaim | undefined>;
    deleteIfUnclaimed(pieceId: string, deletePiece: () => Promise<"deleted" | "not-found">): Promise<DeleteIfUnclaimedResult>;
  };
}

export interface Libp2pConnectionEvent {
  type: "connection.open" | "connection.close" | "connection.error" | "reconnect.scheduled" | "reconnect.attempt" | "reconnect.exhausted";
  peerId: string;
  attempt?: number;
  nextRetryAt?: number;
  error?: string;
}

export interface Libp2pStorageNode {
  readonly peerId: string;
  readonly applicationIdentity: P2PNodeIdentity;
  readonly capabilities: P2PNodeCapabilities;
  readonly node: Libp2p;
  readonly listenAddrs: string[];
  readonly discoveredPeers: readonly P2PPeerDescriptor[];
  readonly connectionStates: ReadonlyMap<string, "connected" | "disconnected" | "reconnecting">;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createLibp2pStorageNode(
  options: Libp2pStorageNodeOptions,
): Promise<Libp2pStorageNode> {
  validateOptions(options);
  const node = await createLibp2p({
    addresses: { listen: options.listenAddrs ?? ["/ip4/127.0.0.1/tcp/0"] },
    transports: [tcp()],
    streamMuxers: [mplex()],
    connectionEncrypters: [noise()],
    services: options.discovery instanceof DhtPeerDiscovery ? createDhtServices() : undefined,
    ...(options.applicationPrivateKey === undefined ? {} : {
      privateKey: privateKeyForLibp2p(options.applicationPrivateKey, options.applicationIdentity.publicKey),
    }),
  });
  if (options.applicationPrivateKey !== undefined) {
    const expectedPeerId = peerIdFromOpenStorePrivateKey(
      options.applicationPrivateKey,
      Buffer.from(options.applicationIdentity.publicKey, "base64"),
    );
    if (node.peerId.toString() !== expectedPeerId) {
      await node.stop();
      throw new TypeError("libp2p peer identity binding failed");
    }
  }
  if (options.discovery instanceof DhtPeerDiscovery) options.discovery.attach(node as never);
  const capabilities: P2PNodeCapabilities = {
    pieceStore: true,
    pieceGet: true,
    pieceDelete: true,
    maxPieceBytes: options.maxPieceBytes,
    allocatedBytes: options.allocatedBytes,
    availableBytes: options.availableBytes,
  };
  let discoveredPeers: readonly P2PPeerDescriptor[] = [];
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  const knownPeers = new Map<string, P2PPeerDescriptor>();
  const connectionStates = new Map<string, "connected" | "disconnected" | "reconnecting">();
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  const emitConnection = (event: Libp2pConnectionEvent) => { try { options.onConnectionEvent?.(event); } catch {} };
  const cancelReconnect = (peerId: string) => {
    const timer = reconnectTimers.get(peerId);
    if (timer !== undefined) clearTimeout(timer);
    reconnectTimers.delete(peerId);
    reconnectAttempts.delete(peerId);
  };
  const scheduleReconnect = (peer: P2PPeerDescriptor, error?: unknown) => {
    if (reconnectTimers.has(peer.nodeId) || node.status !== "started") return;
    const attempt = (reconnectAttempts.get(peer.nodeId) ?? 0) + 1;
    if (attempt > maxReconnectAttempts) {
      connectionStates.set(peer.nodeId, "disconnected");
      emitConnection({
        type: "reconnect.exhausted",
        peerId: peer.nodeId,
        attempt: attempt - 1,
        ...(error === undefined ? {} : { error: String(error).replace(/https?:\/\/[^\s]+/gi, "[peer]").slice(0, 200) }),
      });
      return;
    }
    reconnectAttempts.set(peer.nodeId, attempt);
    connectionStates.set(peer.nodeId, "reconnecting");
    const base = options.reconnectBaseDelayMs ?? 250;
    const max = options.reconnectMaxDelayMs ?? 5_000;
    const delay = Math.min(max, base * 2 ** Math.min(attempt - 1, 8));
    emitConnection({ type: "reconnect.scheduled", peerId: peer.nodeId, attempt, nextRetryAt: Date.now() + delay, ...(error === undefined ? {} : { error: String(error).slice(0, 200) }) });
    reconnectTimers.set(peer.nodeId, setTimeout(() => {
      reconnectTimers.delete(peer.nodeId);
      emitConnection({ type: "reconnect.attempt", peerId: peer.nodeId, attempt });
      void dialPeer(peer).catch((err) => scheduleReconnect(peer, err));
    }, delay));
  };
  const dialPeer = async (peer: P2PPeerDescriptor): Promise<void> => {
    if (peer.multiaddr === undefined || node.status !== "started") return;
    if (node.getConnections().some((connection) => connection.remotePeer.toString() === peer.nodeId)) {
      cancelReconnect(peer.nodeId);
      return;
    }
    try {
      const connection = await node.dial(multiaddr(peer.multiaddr), { signal: AbortSignal.timeout(2_000) });
      if (connection.remotePeer.toString() !== peer.nodeId) {
        await connection.close();
        throw new Error("dialed peer identity mismatch");
      }
      cancelReconnect(peer.nodeId);
    } catch (error) {
      emitConnection({ type: "connection.error", peerId: peer.nodeId, error: String(error).slice(0, 200) });
      throw error;
    }
  };
  node.addEventListener("peer:connect", (event) => {
    const peerId = event.detail.toString();
    cancelReconnect(peerId);
    connectionStates.set(peerId, "connected");
    reconnectAttempts.delete(peerId);
    emitConnection({ type: "connection.open", peerId });
  });
  node.addEventListener("peer:disconnect", (event) => {
    const peerId = event.detail.toString();
    connectionStates.set(peerId, "disconnected");
    emitConnection({ type: "connection.close", peerId });
    const peer = knownPeers.get(peerId);
    if (peer) scheduleReconnect(peer);
  });
  await node.handle(OPENSTORE_PIECE_PROTOCOL, async (stream) => {
    try {
      const request = await readMessage<PieceRequest>(stream as AsyncIterable<unknown>);
      const response = await handleRequest(request, options);
      stream.send(Buffer.from(JSON.stringify(response)));
      await stream.close();
    } catch {
      stream.send(Buffer.from(JSON.stringify({ status: 400, error: "malformed request" } satisfies PieceResponse)));
      await stream.close();
    }
  });
  if (options.provenance) {
    await node.handle(OPENSTORE_PROVENANCE_PROTOCOL, async (stream) => {
      try {
        const request = await readMessage<ProvenanceRequest>(stream as AsyncIterable<unknown>);
        const response = await handleProvenanceRequest(request, options);
        stream.send(Buffer.from(JSON.stringify(response)));
      } catch (error) {
        stream.send(Buffer.from(JSON.stringify({ status: 409, error: error instanceof Error ? error.message : "provenance request failed" })));
      } finally {
        void stream.close();
      }
    });
  }
  const wrapper: Libp2pStorageNode = {
    peerId: node.peerId.toString(),
    applicationIdentity: { ...options.applicationIdentity },
    capabilities,
    node,
    get listenAddrs() {
      return node.getMultiaddrs().map((address) => address.toString());
    },
    get discoveredPeers() {
      return discoveredPeers;
    },
    get connectionStates() {
      return new Map(connectionStates);
    },
    async start(): Promise<void> {
      if (node.status !== "started") await node.start();
      if (options.discovery) {
        const descriptor = createLocalDescriptor(wrapper, options);
        await options.discovery.start(descriptor, {
          refreshIntervalMs: options.discoveryRefreshIntervalMs,
          onRefresh: async (peers) => {
            for (const peer of peers) knownPeers.set(peer.nodeId, peer);
            discoveredPeers = await reconcilePeers(wrapper, peers);
            for (const peer of discoveredPeers) {
              if (options.placementRegistry) options.placementRegistry.registerDiscoveredPeer(peer);
            }
          },
          onPeerRemoved: async (nodeIds) => {
            for (const nodeId of nodeIds) {
              knownPeers.delete(nodeId);
              cancelReconnect(nodeId);
              connectionStates.set(nodeId, "disconnected");
              options.placementRegistry?.removeDiscoveredPeer(nodeId);
            }
          },
        });
        await options.discovery.advertise(descriptor);
      }
    },
    async stop(): Promise<void> {
      for (const timer of reconnectTimers.values()) clearTimeout(timer);
      reconnectTimers.clear();
      knownPeers.clear();
      await options.discovery?.stop();
      if (node.status === "started") await node.stop();
    },
  };
  return wrapper;
}

const pendingDials = new WeakMap<Libp2pStorageNode, Set<string>>();

async function reconcilePeers(wrapper: Libp2pStorageNode, discovered: readonly P2PPeerDescriptor[]): Promise<readonly P2PPeerDescriptor[]> {
  const pending = pendingDials.get(wrapper) ?? new Set<string>();
  pendingDials.set(wrapper, pending);
  const peers = discovered
    .filter((peer) => peer.nodeId !== wrapper.peerId && peer.multiaddr !== undefined)
    .map((peer) => {
      validateP2PPeerDescriptor(peer);
      return peer;
    });
  const unique = [...new Map(peers.map((peer) => [peer.nodeId, peer])).values()];
  await Promise.all(unique.map(async (peer) => {
    if (pending.has(peer.nodeId)) return;
    if (wrapper.node.getConnections().some((connection) => connection.remotePeer.toString() === peer.nodeId)) return;
    pending.add(peer.nodeId);
    try {
      const connection = await wrapper.node.dial(multiaddr(peer.multiaddr!), {
        signal: AbortSignal.timeout(2_000),
      });
      if (connection.remotePeer.toString() !== peer.nodeId) await connection.close();
    } catch {
      // Unreachable peers are retried by scheduled reconciliation.
    } finally {
      pending.delete(peer.nodeId);
    }
  }));
  return unique;
}

function createLocalDescriptor(wrapper: Libp2pStorageNode, options: Libp2pStorageNodeOptions): P2PPeerDescriptor {
  const publicKey = Buffer.from(wrapper.applicationIdentity.publicKey, "base64");
  return {
    nodeId: wrapper.peerId,
    baseUrl: `libp2p://${wrapper.peerId}`,
    multiaddr: wrapper.listenAddrs[0],
    identity: wrapper.applicationIdentity,
    capabilities: wrapper.capabilities,
    ...(options.applicationPrivateKey === undefined ? {} : { identityBinding: wrapper.peerId }),
  };
}

function privateKeyForLibp2p(privateKeyDer: Buffer, publicKeyBase64: string) {
  const publicKey = Buffer.from(publicKeyBase64, "base64");
  const seed = privateKeyDer.subarray(-32);
  return privateKeyFromRaw(Buffer.concat([seed, publicKey.subarray(-32)]));
}

export class Libp2pPieceTransport implements P2PTransport {
  readonly protocol = "libp2p";

  async storePiece(node: P2PNodeAddress, pieceId: string, data: Buffer, options: P2PTransportRequestOptions): Promise<{ status: number }> {
    return this.request(node, { op: "store", pieceId, data: data.toString("base64") }, options) as Promise<{ status: number }>;
  }

  async getPiece(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions): Promise<P2PGetResult> {
    const response = await this.request(node, { op: "get", pieceId }, options);
    return { status: response.status, bytes: response.data === undefined ? undefined : Buffer.from(response.data, "base64") };
  }

  async deletePiece(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions): Promise<{ status: number }> {
    return this.request(node, { op: "delete", pieceId }, options) as Promise<{ status: number }>;
  }

  async health(node: P2PNodeAddress, options: P2PTransportRequestOptions): Promise<P2PHealthResult> {
    try {
      await this.request(node, { op: "health", pieceId: "health" }, options);
      return { available: true, capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true } };
    } catch {
      return { available: false, capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true } };
    }
  }

  private async request(node: P2PNodeAddress, request: PieceRequest, options: P2PTransportRequestOptions): Promise<PieceResponse> {
    validatePieceRequest(request);
    if (!node.baseUrl.startsWith("libp2p:")) throw new TypeError("libp2p transport requires a libp2p endpoint");
    const multiaddrText = (node as P2PNodeAddress & { multiaddr?: string }).multiaddr;
    if (typeof multiaddrText !== "string" || multiaddrText.length === 0) throw new TypeError("libp2p node requires a multiaddr");
    const binding = (node as P2PNodeAddress & { identityBinding?: string }).identityBinding;
    if (binding !== undefined && binding !== node.nodeId) throw new TypeError("libp2p identity binding does not match peer ID");
    if (node.identity !== undefined && peerIdFromOpenStorePublicKey(Buffer.from(node.identity.publicKey, "base64")) !== node.nodeId) {
      throw new TypeError("libp2p OpenStore identity does not match peer ID");
    }
    if (multiaddrText.includes("/p2p/") && !multiaddrText.endsWith(`/p2p/${node.nodeId}`)) {
      throw new TypeError("libp2p node identity does not match multiaddr");
    }
    const local = await createLibp2p({
      transports: [tcp()],
      streamMuxers: [mplex()],
      connectionEncrypters: [noise()],
      addresses: { listen: [] },
    });
    try {
      await local.start();
      const stream = await local.dialProtocol(multiaddr(multiaddrText), OPENSTORE_PIECE_PROTOCOL, {
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      stream.send(Buffer.from(JSON.stringify(request)));
      void stream.close();
      const response = await readMessage<PieceResponse>(stream as AsyncIterable<unknown>);
      validatePieceResponse(response);
      await stream.close();
      return response;
    } finally {
      await local.stop();
    }
  }
}

export class Libp2pProvenanceTransport implements P2PProvenanceTransport {
  async createClaim(node: P2PNodeAddress, claim: PieceClaim, options: P2PTransportRequestOptions): Promise<PieceClaim> {
    return (await this.request(node, { op: "claim-create", claim }, options)).claim as PieceClaim;
  }
  async storeClaimedPiece(node: P2PNodeAddress, pieceId: string, claimId: string, data: Buffer, options: P2PTransportRequestOptions): Promise<void> {
    await this.request(node, { op: "claim-store", pieceId, claimId, data: data.toString("base64") }, options);
  }
  async markClaimReferenced(node: P2PNodeAddress, pieceId: string, claimId: string, options: P2PTransportRequestOptions): Promise<PieceClaim> {
    return (await this.request(node, { op: "claim-reference", pieceId, claimId }, options)).claim as PieceClaim;
  }
  async releaseClaim(node: P2PNodeAddress, pieceId: string, claimId: string, clientNamespace: string, options: P2PTransportRequestOptions): Promise<PieceClaim> {
    return (await this.request(node, { op: "claim-release", pieceId, claimId, clientNamespace }, options)).claim as PieceClaim;
  }
  async reconcileClaim(node: P2PNodeAddress, pieceId: string, claimId: string, options: P2PTransportRequestOptions): Promise<PieceClaim | undefined> {
    return (await this.request(node, { op: "claim-reconcile", pieceId, claimId }, options)).claim as PieceClaim | undefined;
  }
  async deletePieceIfUnclaimed(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions): Promise<DeleteIfUnclaimedResult> {
    return (await this.request(node, { op: "delete-if-unclaimed", pieceId }, options)).result as DeleteIfUnclaimedResult;
  }
  private async request(node: P2PNodeAddress, request: ProvenanceRequest, options: P2PTransportRequestOptions): Promise<{ claim?: PieceClaim; result?: DeleteIfUnclaimedResult; status?: number }> {
    validatePieceNode(node);
    const local = await createLibp2p({ transports: [tcp()], streamMuxers: [mplex()], connectionEncrypters: [noise()], addresses: { listen: [] } });
    try {
      await local.start();
      const stream = await local.dialProtocol(multiaddr((node as P2PNodeAddress & { multiaddr?: string }).multiaddr as string), OPENSTORE_PROVENANCE_PROTOCOL, { signal: AbortSignal.timeout(options.timeoutMs) });
      stream.send(Buffer.from(JSON.stringify(request)));
      void stream.close();
      const response = await readMessage<{ claim?: PieceClaim; result?: DeleteIfUnclaimedResult; status?: number; error?: string }>(stream as AsyncIterable<unknown>);
      if (response.status !== undefined && response.status >= 400) throw new Error(response.error ?? `provenance request returned ${response.status}`);
      return response;
    } finally {
      await local.stop();
    }
  }
}

async function handleProvenanceRequest(request: ProvenanceRequest, options: Libp2pStorageNodeOptions): Promise<Record<string, unknown>> {
  if (!options.provenance) throw new Error("provenance unavailable");
  if (request.op === "claim-create" && request.claim) return { status: 200, claim: await options.provenance.createClaim(request.claim) };
  if (!request.pieceId) throw new Error("malformed provenance request");
  if (request.op !== "delete-if-unclaimed" && !request.claimId) throw new Error("malformed provenance request");
  const pieceId = request.pieceId;
  const claimId = request.claimId;
  if (request.op === "claim-store") {
    if (!request.data) throw new Error("missing claim data");
    await options.provenance.associatePiece(pieceId, claimId!, async () => {
      const bytes = Buffer.from(request.data!, "base64");
      if (hashPieceId(bytes) !== pieceId) throw new Error("piece bytes do not match piece id");
      const status = await options.storePiece(pieceId, bytes);
      if (status >= 400) throw new Error(`store returned ${status}`);
    });
    return { status: 200 };
  }
  if (request.op === "claim-reference") return { status: 200, claim: await options.provenance.markReferenced(pieceId, claimId!) };
  if (request.op === "claim-release") return { status: 200, claim: await options.provenance.releaseClaim(pieceId, claimId!, request.clientNamespace ?? "") };
  if (request.op === "claim-reconcile") {
    const claim = await options.provenance.reconcile(pieceId, claimId!);
    return { status: 200, ...(claim === undefined ? {} : { claim }) };
  }
  const result = await options.provenance.deleteIfUnclaimed(pieceId, async () => {
    const status = await options.deletePiece(pieceId);
    return status === 404 ? "not-found" : status >= 400 ? "not-found" : "deleted";
  });
  return { status: 200, result };
}

function validatePieceNode(node: P2PNodeAddress): void {
  if (!node.baseUrl.startsWith("libp2p:") || typeof (node as P2PNodeAddress & { multiaddr?: string }).multiaddr !== "string") throw new TypeError("libp2p provenance requires a multiaddr");
}

async function handleRequest(request: PieceRequest, options: Libp2pStorageNodeOptions): Promise<PieceResponse> {
  validatePieceRequest(request);
  if (request.op === "store") {
    const data = Buffer.from(request.data as string, "base64");
    if (options.maxPieceBytes !== undefined && data.length > options.maxPieceBytes) return { status: 413, error: "piece too large" };
    return { status: await options.storePiece(request.pieceId, data) };
  }

  if (request.op === "get") {
    const data = await options.getPiece(request.pieceId);
    return data === null ? { status: 404 } : { status: 200, data: data.toString("base64") };
  }
  if (request.op === "health") return { status: 200 };
  return { status: await options.deletePiece(request.pieceId) };
}

async function readMessage<T>(stream: AsyncIterable<unknown>): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(
      chunk instanceof Uint8Array
        ? chunk
        : typeof (chunk as { subarray?: unknown }).subarray === "function"
          ? (chunk as { subarray: () => Uint8Array }).subarray()
          : (() => { throw new Error("malformed message"); })(),
    );
    total += bytes.length;
    if (total > MAX_MESSAGE_BYTES) throw new Error("message too large");
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("malformed message");
  return parsed as T;
}

function validateOptions(options: Libp2pStorageNodeOptions): void {
  if (!options.applicationIdentity || typeof options.applicationIdentity.publicKey !== "string") throw new TypeError("application identity is required");
  const publicKey = Buffer.from(options.applicationIdentity.publicKey, "base64");
  if (publicKey.length !== 44 || publicKey.toString("base64") !== options.applicationIdentity.publicKey) throw new TypeError("application identity is invalid");
  if (options.maxPieceBytes !== undefined && (!Number.isSafeInteger(options.maxPieceBytes) || options.maxPieceBytes <= 0)) throw new TypeError("maxPieceBytes must be positive");
  if (options.discoveryRefreshIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.discoveryRefreshIntervalMs) || options.discoveryRefreshIntervalMs <= 0)) {
    throw new TypeError("discoveryRefreshIntervalMs must be a positive safe integer");
  }
  for (const field of ["reconnectBaseDelayMs", "reconnectMaxDelayMs", "maxReconnectAttempts"] as const) {
    const value = options[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError(`${field} must be a positive safe integer`);
    }
  }
  if (options.reconnectMaxDelayMs !== undefined && options.reconnectBaseDelayMs !== undefined &&
      options.reconnectMaxDelayMs < options.reconnectBaseDelayMs) {
    throw new TypeError("reconnectMaxDelayMs must be at least reconnectBaseDelayMs");
  }
}

function validatePieceRequest(request: PieceRequest): void {
  if (!request || !["store", "get", "delete", "health"].includes(request.op) || typeof request.pieceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.pieceId)) {
    throw new Error("malformed request");
  }
  if (request.op === "store" && (typeof request.data !== "string" || request.data.length === 0 || request.data.length > MAX_MESSAGE_BYTES * 2 || !isBase64(request.data))) {
    throw new Error("malformed request");
  }
}

function validatePieceResponse(response: PieceResponse): void {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error("malformed response");
  if (response.data !== undefined && (!isBase64(response.data) || response.data.length > MAX_MESSAGE_BYTES * 2)) throw new Error("malformed response");
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
