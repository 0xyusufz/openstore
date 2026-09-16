/**
 * OpenStore P2P foundation (OPENSTORE-032).
 *
 * This module defines transport-neutral node and piece-operation contracts.
 * The MVP implementation remains HTTP; no libp2p or overlay network is
 * implied by these types.
 */

export const P2P_NODE_MODEL_VERSION = 1;

export interface P2PNodeIdentity {
  /** Base64 Ed25519 public key; private key material is never representable here. */
  publicKey: string;
}

export interface P2PNodeAddress {
  nodeId: string;
  baseUrl: string;
  multiaddr?: string;
  identityBinding?: string;
  identity?: P2PNodeIdentity;
}

export interface Libp2pNodeAddress extends P2PNodeAddress {
  /** Static dial address, including /p2p/<peer-id>. */
  multiaddr: string;
}

export interface P2PNodeCapabilities {
  pieceStore: boolean;
  pieceGet: boolean;
  pieceDelete: boolean;
  maxPieceBytes?: number;
  allocatedBytes?: number;
  availableBytes?: number;
}

export interface P2PNodeDescriptor extends P2PNodeAddress {
  identity: P2PNodeIdentity;
  capabilities: P2PNodeCapabilities;
}

export interface P2PPeerDescriptor extends P2PNodeDescriptor {
  /** Static libp2p dial address, including /p2p/<peer-id> when used. */
  multiaddr?: string;
  /** Peer ID derived from the same OpenStore Ed25519 public key. */
  identityBinding?: string;
}

export interface PeerDiscovery {
  start(local: P2PPeerDescriptor, options?: PeerDiscoveryOptions): Promise<void>;
  advertise(local: P2PPeerDescriptor): Promise<void>;
  discover(): Promise<readonly P2PPeerDescriptor[]>;
  stop(): Promise<void>;
}

export interface PeerDiscoveryOptions {
  refreshIntervalMs?: number;
  onRefresh?: (peers: readonly P2PPeerDescriptor[]) => Promise<void> | void;
  onPeerRemoved?: (nodeIds: readonly string[]) => Promise<void> | void;
}

export interface P2PTransportRequestOptions {
  timeoutMs: number;
}

export interface P2PStoreResult {
  status: number;
}

export interface P2PGetResult {
  status: number;
  bytes?: Buffer;
}

export interface P2PHealthResult {
  available: boolean;
  capabilities: P2PNodeCapabilities;
}

export interface P2PTransport {
  readonly protocol: string;
  storePiece(
    node: P2PNodeAddress,
    pieceId: string,
    data: Buffer,
    options: P2PTransportRequestOptions,
  ): Promise<P2PStoreResult>;
  getPiece(
    node: P2PNodeAddress,
    pieceId: string,
    options: P2PTransportRequestOptions,
  ): Promise<P2PGetResult>;
  deletePiece(
    node: P2PNodeAddress,
    pieceId: string,
    options: P2PTransportRequestOptions,
  ): Promise<{ status: number }>;
  health(
    node: P2PNodeAddress,
    options: P2PTransportRequestOptions,
  ): Promise<P2PHealthResult>;
}

export function validateP2PNodeAddress(node: unknown): asserts node is P2PNodeAddress {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TypeError("node address must be an object");
  }
  const value = node as Record<string, unknown>;
  if (typeof value.nodeId !== "string" || value.nodeId.length === 0 || value.nodeId.length > 512) {
    throw new TypeError("node address nodeId must be a non-empty string");
  }
  if (typeof value.baseUrl !== "string" || value.baseUrl.length === 0 || value.baseUrl.length > 2048) {
    throw new TypeError("node address baseUrl must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(value.baseUrl);
  } catch {
    throw new TypeError("node address baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "libp2p:") {
    throw new TypeError("node address baseUrl must use http or https or libp2p");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError("node address baseUrl must not contain credentials");
  }
}

export function validateP2PNodeIdentity(identity: unknown): asserts identity is P2PNodeIdentity {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("node identity must be an object");
  }
  const value = identity as Record<string, unknown>;
  if (typeof value.publicKey !== "string" || value.publicKey.length === 0) {
    throw new TypeError("node identity publicKey must be a non-empty string");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value.publicKey, "base64");
  } catch {
    throw new TypeError("node identity publicKey must be base64");
  }
  if (decoded.length !== 44 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.publicKey)) {
    throw new TypeError("node identity publicKey must be an Ed25519 public key");
  }
}

export function createP2PNodeDescriptor(
  address: P2PNodeAddress,
  identity: P2PNodeIdentity,
  capabilities: P2PNodeCapabilities,
): P2PNodeDescriptor {
  validateP2PNodeAddress(address);
  validateP2PNodeIdentity(identity);
  if (!capabilities || capabilities.pieceStore !== true || capabilities.pieceGet !== true || capabilities.pieceDelete !== true) {
    throw new TypeError("node capabilities must enable piece store, get, and delete");
  }
  if (
    capabilities.maxPieceBytes !== undefined &&
    (!Number.isSafeInteger(capabilities.maxPieceBytes) || capabilities.maxPieceBytes <= 0)
  ) {
    throw new TypeError("node maxPieceBytes must be a positive safe integer");
  }
  for (const field of ["allocatedBytes", "availableBytes"] as const) {
    if (capabilities[field] !== undefined &&
      (!Number.isSafeInteger(capabilities[field]) || capabilities[field] < 0)) {
      throw new TypeError(`node ${field} must be a non-negative safe integer`);
    }
  }
  if (capabilities.allocatedBytes !== undefined && capabilities.availableBytes !== undefined &&
      capabilities.availableBytes > capabilities.allocatedBytes) {
    throw new TypeError("node availableBytes cannot exceed allocatedBytes");
  }
  return { ...address, identity: { ...identity }, capabilities: { ...capabilities } };
}

const SENSITIVE_DESCRIPTOR_KEYS = new Set([
  "privateKey",
  "secretKey",
  "seed",
  "password",
  "recoveryPhrase",
  "mnemonic",
]);

export function validateP2PPeerDescriptor(value: unknown): asserts value is P2PPeerDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("peer descriptor must be an object");
  }
  const descriptor = value as Record<string, unknown>;
  rejectSensitiveKeys(descriptor);
  validateP2PNodeAddress(descriptor);
  validateP2PNodeIdentity(descriptor.identity);
  if (!descriptor.capabilities || typeof descriptor.capabilities !== "object") {
    throw new TypeError("peer descriptor capabilities are required");
  }
  const capabilities = descriptor.capabilities as P2PNodeCapabilities;
  if (capabilities.pieceStore !== true || capabilities.pieceGet !== true || capabilities.pieceDelete !== true) {
    throw new TypeError("peer descriptor capabilities are invalid");
  }
  for (const field of ["allocatedBytes", "availableBytes"] as const) {
    if (capabilities[field] !== undefined &&
      (!Number.isSafeInteger(capabilities[field]) || capabilities[field] < 0)) {
      throw new TypeError(`peer descriptor ${field} is invalid`);
    }
  }
  if (descriptor.multiaddr !== undefined) {
    if (typeof descriptor.multiaddr !== "string" || descriptor.multiaddr.length === 0 || descriptor.multiaddr.length > 2048) {
      throw new TypeError("peer descriptor multiaddr is invalid");
    }
    if (!descriptor.multiaddr.startsWith("/ip4/") && !descriptor.multiaddr.startsWith("/ip6/") && !descriptor.multiaddr.startsWith("/dns")) {
      throw new TypeError("peer descriptor multiaddr uses an unsupported protocol");
    }
    if (descriptor.multiaddr.includes("/p2p/") && !descriptor.multiaddr.endsWith(`/p2p/${descriptor.nodeId}`)) {
      throw new TypeError("peer descriptor identity does not match multiaddr");
    }
  }
  if (descriptor.identityBinding !== undefined &&
    (typeof descriptor.identityBinding !== "string" || descriptor.identityBinding !== descriptor.nodeId)) {
    throw new TypeError("peer descriptor identity binding is invalid");
  }
  if (descriptor.identityBinding !== undefined &&
    peerIdFromOpenStorePublicKey(Buffer.from(descriptor.identity.publicKey, "base64")) !== descriptor.identityBinding) {
    throw new TypeError("peer descriptor OpenStore identity does not match peer ID");
  }
  return;
}

function rejectSensitiveKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_DESCRIPTOR_KEYS.has(key)) throw new TypeError("peer descriptor contains private material");
    rejectSensitiveKeys(nested);
  }
}
import { peerIdFromOpenStorePublicKey } from "./identity-binding.js";
