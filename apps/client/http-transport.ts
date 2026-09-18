import { createAuthHeaders } from "../../packages/auth/index.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  type P2PGetResult,
  type P2PHealthResult,
  type P2PNodeAddress,
  type P2PTransport,
  type P2PTransportRequestOptions,
  type P2PProvenanceTransport,
} from "../../packages/p2p/index.js";
import { Libp2pPieceTransport, Libp2pProvenanceTransport } from "../../packages/p2p/libp2p.js";
import { validatePieceClaim, type DeleteIfUnclaimedResult, type PieceClaim } from "../../packages/provenance/index.js";

/** Error message used when a node response exceeds the caller-configured bound. */
export const RESPONSE_TOO_LARGE_MESSAGE = "response body exceeds size bound";

function responseCap(options: P2PTransportRequestOptions): number {
  const cap = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new TypeError("maxResponseBytes must be a positive safe integer");
  return cap;
}

/**
 * Read a fetch body with an explicit byte bound. The declared
 * content-length is checked first so oversized responses fail fast
 * without buffering; the stream is then drained incrementally so a
 * lying content-length cannot bypass the cap either.
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      try { await response.body?.cancel(); } catch {}
      throw new Error(RESPONSE_TOO_LARGE_MESSAGE);
    }
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(RESPONSE_TOO_LARGE_MESSAGE);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface HttpTransportIdentity {
  publicKey: Buffer;
  privateKey: Buffer;
}

/** HTTP implementation of the transport-neutral P2P piece contract. */
export class HttpStorageTransport implements P2PTransport {
  readonly protocol = "http";

  constructor(private readonly identity?: HttpTransportIdentity) {}

  async storePiece(
    node: P2PNodeAddress,
    pieceId: string,
    data: Buffer,
    options: P2PTransportRequestOptions,
  ): Promise<{ status: number }> {
    const path = "/pieces";
    const body = JSON.stringify({ id: pieceId, data: data.toString("base64") });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.identity) Object.assign(headers, createAuthHeaders(this.identity, "POST", path, Buffer.from(body)));
    const response = await fetch(`${normalize(node.baseUrl)}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return { status: response.status };
  }

  async getPiece(
    node: P2PNodeAddress,
    pieceId: string,
    options: P2PTransportRequestOptions,
  ): Promise<P2PGetResult> {
    const path = `/pieces/${encodeURIComponent(pieceId)}`;
    const headers: Record<string, string> = {};
    if (this.identity) Object.assign(headers, createAuthHeaders(this.identity, "GET", path));
    const response = await fetch(`${normalize(node.baseUrl)}${path}`, {
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return {
      status: response.status,
      bytes: response.status === 200 ? await readBoundedBody(response, responseCap(options)) : undefined,
    };
  }

  async deletePiece(
    node: P2PNodeAddress,
    pieceId: string,
    options: P2PTransportRequestOptions,
  ): Promise<{ status: number }> {
    const path = `/pieces/${encodeURIComponent(pieceId)}`;
    const headers: Record<string, string> = {};
    if (this.identity) Object.assign(headers, createAuthHeaders(this.identity, "DELETE", path));
    const response = await fetch(`${normalize(node.baseUrl)}${path}`, {
      method: "DELETE",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return { status: response.status };
  }

  async health(
    node: P2PNodeAddress,
    options: P2PTransportRequestOptions,
  ): Promise<P2PHealthResult> {
    const response = await fetch(`${normalize(node.baseUrl)}/health`, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return {
      available: response.ok,
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true },
    };
  }
}

function normalize(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Routes each endpoint to its explicitly configured transport protocol. */
export class MixedStorageTransport implements P2PTransport {
  readonly protocol = "mixed";
  private readonly libp2p = new Libp2pPieceTransport();

  constructor(private readonly http: HttpStorageTransport = new HttpStorageTransport()) {}

  async storePiece(node: P2PNodeAddress, pieceId: string, data: Buffer, options: P2PTransportRequestOptions) {
    return this.forNode(node).storePiece(node, pieceId, data, options);
  }

  async getPiece(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions) {
    return this.forNode(node).getPiece(node, pieceId, options);
  }

  async deletePiece(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions) {
    return this.forNode(node).deletePiece(node, pieceId, options);
  }

  async health(node: P2PNodeAddress, options: P2PTransportRequestOptions) {
    return this.forNode(node).health(node, options);
  }

  private forNode(node: P2PNodeAddress): P2PTransport {
    if (node.baseUrl.startsWith("libp2p:")) return this.libp2p;
    if (node.baseUrl.startsWith("http:") || node.baseUrl.startsWith("https:")) return this.http;
    throw new TypeError("unsupported storage transport");
  }
}

export class HttpProvenanceTransport implements P2PProvenanceTransport {
  constructor(private readonly identity?: HttpTransportIdentity) {}
  async createClaim(node: P2PNodeAddress, claim: PieceClaim, options: P2PTransportRequestOptions): Promise<PieceClaim> {
    return this.post(node, "/v2/pieces/claims", claim, options) as Promise<PieceClaim>;
  }
  async storeClaimedPiece(node: P2PNodeAddress, pieceId: string, claimId: string, data: Buffer, options: P2PTransportRequestOptions): Promise<void> {
    await this.post(node, `/v2/pieces/${encodeURIComponent(pieceId)}/store`, { claimId, data: data.toString("base64") }, options);
  }
  async markClaimReferenced(node: P2PNodeAddress, pieceId: string, claimId: string, options: P2PTransportRequestOptions): Promise<PieceClaim> {
    return this.post(node, `/v2/pieces/${encodeURIComponent(pieceId)}/reference`, { claimId }, options) as Promise<PieceClaim>;
  }
  async releaseClaim(node: P2PNodeAddress, pieceId: string, claimId: string, namespace: string, options: P2PTransportRequestOptions): Promise<PieceClaim> {
    return this.post(node, `/v2/pieces/${encodeURIComponent(pieceId)}/release`, { claimId, clientNamespace: namespace }, options) as Promise<PieceClaim>;
  }
  async reconcileClaim(node: P2PNodeAddress, pieceId: string, claimId: string, options: P2PTransportRequestOptions): Promise<PieceClaim | undefined> {
    const result = await this.post(node, `/v2/pieces/${encodeURIComponent(pieceId)}/reconcile`, { claimId }, options) as { claim?: PieceClaim };
    return result.claim;
  }
  async deletePieceIfUnclaimed(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions): Promise<DeleteIfUnclaimedResult> {
    const response = await this.request(node, "DELETE", `/v2/pieces/${encodeURIComponent(pieceId)}`, undefined, options);
    if (response.status === 204) return { status: "deleted" };
    if (response.status === 404) return { status: "not-found" };
    if (response.status === 409) return { status: "still-claimed", claims: [] };
    return { status: "conflict" };
  }
  private async post(node: P2PNodeAddress, path: string, value: unknown, options: P2PTransportRequestOptions): Promise<unknown> {
    const response = await this.request(node, "POST", path, Buffer.from(JSON.stringify(value)), options);
    if (response.status < 200 || response.status >= 300) throw new Error(`provenance request returned ${response.status}`);
    const payload = response.body ? JSON.parse(response.body.toString("utf8")) as Record<string, unknown> : {};
    // A malicious node must not be able to inject malformed claim state:
    // validate any returned claim before the caller trusts it.
    if (payload.claim !== undefined && payload.claim !== null) {
      try {
        validatePieceClaim(payload.claim as PieceClaim);
      } catch {
        throw new Error("provenance claim response is invalid");
      }
      return payload.claim;
    }
    return payload;
  }
  private async request(node: P2PNodeAddress, method: string, path: string, body: Buffer | undefined, options: P2PTransportRequestOptions): Promise<{ status: number; body?: Buffer }> {
    const headers: Record<string, string> = { ...(body ? { "content-type": "application/json" } : {}) };
    if (this.identity) Object.assign(headers, createAuthHeaders(this.identity, method, path, body));
    const response = await fetch(`${normalize(node.baseUrl)}${path}`, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}), signal: AbortSignal.timeout(options.timeoutMs) });
    return { status: response.status, body: response.status === 204 ? undefined : await readBoundedBody(response, responseCap(options)) };
  }
}

export class MixedProvenanceTransport implements P2PProvenanceTransport {
  private readonly libp2p = new Libp2pProvenanceTransport();
  constructor(private readonly http: HttpProvenanceTransport = new HttpProvenanceTransport()) {}
  createClaim(node: P2PNodeAddress, claim: PieceClaim, options: P2PTransportRequestOptions) { return this.forNode(node).createClaim(node, claim, options); }
  storeClaimedPiece(node: P2PNodeAddress, pieceId: string, claimId: string, data: Buffer, options: P2PTransportRequestOptions) { return this.forNode(node).storeClaimedPiece(node, pieceId, claimId, data, options); }
  markClaimReferenced(node: P2PNodeAddress, pieceId: string, claimId: string, options: P2PTransportRequestOptions) { return this.forNode(node).markClaimReferenced(node, pieceId, claimId, options); }
  releaseClaim(node: P2PNodeAddress, pieceId: string, claimId: string, namespace: string, options: P2PTransportRequestOptions) { return this.forNode(node).releaseClaim(node, pieceId, claimId, namespace, options); }
  reconcileClaim(node: P2PNodeAddress, pieceId: string, claimId: string, options: P2PTransportRequestOptions) { return this.forNode(node).reconcileClaim(node, pieceId, claimId, options); }
  deletePieceIfUnclaimed(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions) { return this.forNode(node).deletePieceIfUnclaimed(node, pieceId, options); }
  private forNode(node: P2PNodeAddress): P2PProvenanceTransport {
    return node.baseUrl.startsWith("libp2p:") ? this.libp2p : this.http;
  }
}
