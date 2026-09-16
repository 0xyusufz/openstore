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
}

export interface P2PNodeDescriptor extends P2PNodeAddress {
  identity: P2PNodeIdentity;
  capabilities: P2PNodeCapabilities;
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
  return { ...address, identity: { ...identity }, capabilities: { ...capabilities } };
}
