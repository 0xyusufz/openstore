import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { mplex } from "@libp2p/mplex";
import { noise } from "@chainsafe/libp2p-noise";
import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "@libp2p/interface";
import type { P2PNodeCapabilities, P2PNodeIdentity, P2PTransport, P2PTransportRequestOptions, P2PNodeAddress, P2PGetResult, P2PHealthResult, PeerDiscovery, P2PPeerDescriptor } from "./index.js";
import { validateP2PPeerDescriptor } from "./index.js";

export const OPENSTORE_PIECE_PROTOCOL = "/openstore/piece/1.0.0";
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

export interface Libp2pStorageNodeOptions {
  applicationIdentity: P2PNodeIdentity;
  listenAddrs?: string[];
  maxPieceBytes?: number;
  storePiece: (pieceId: string, data: Buffer) => Promise<number>;
  getPiece: (pieceId: string) => Promise<Buffer | null>;
  deletePiece: (pieceId: string) => Promise<number>;
  discovery?: PeerDiscovery;
}

export interface Libp2pStorageNode {
  readonly peerId: string;
  readonly applicationIdentity: P2PNodeIdentity;
  readonly capabilities: P2PNodeCapabilities;
  readonly node: Libp2p;
  readonly listenAddrs: string[];
  readonly discoveredPeers: readonly P2PPeerDescriptor[];
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
  });
  const capabilities: P2PNodeCapabilities = {
    pieceStore: true,
    pieceGet: true,
    pieceDelete: true,
    maxPieceBytes: options.maxPieceBytes,
  };
  let discoveredPeers: readonly P2PPeerDescriptor[] = [];
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
    async start(): Promise<void> {
      if (node.status !== "started") await node.start();
      if (options.discovery) {
        const descriptor = createLocalDescriptor(wrapper, options);
        await options.discovery.start(descriptor);
        await options.discovery.advertise(descriptor);
        const discovered = await options.discovery.discover();
        const peers = discovered.filter((peer) => peer.nodeId !== wrapper.peerId && peer.multiaddr !== undefined);
        const seen = new Set<string>();
        for (const peer of peers) {
          validateP2PPeerDescriptor(peer);
          if (seen.has(peer.nodeId)) continue;
          seen.add(peer.nodeId);
          try {
            await node.dial(multiaddr(peer.multiaddr!));
          } catch {
            // Discovery must not take down the node when a bootstrap peer is unavailable.
          }
        }
        discoveredPeers = peers;
      }
    },
    async stop(): Promise<void> {
      await options.discovery?.stop();
      if (node.status === "started") await node.stop();
    },
  };
  return wrapper;
}

function createLocalDescriptor(wrapper: Libp2pStorageNode, options: Libp2pStorageNodeOptions): P2PPeerDescriptor {
  return {
    nodeId: wrapper.peerId,
    baseUrl: `libp2p://${wrapper.peerId}`,
    multiaddr: wrapper.listenAddrs[0],
    identity: wrapper.applicationIdentity,
    capabilities: wrapper.capabilities,
  };
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
    const multiaddrText = (node as P2PNodeAddress & { multiaddr?: string }).multiaddr;
    if (typeof multiaddrText !== "string" || multiaddrText.length === 0) throw new TypeError("libp2p node requires a multiaddr");
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
