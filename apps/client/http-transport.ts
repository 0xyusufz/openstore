import { createAuthHeaders } from "../../packages/auth/index.js";
import type {
  P2PGetResult,
  P2PHealthResult,
  P2PNodeAddress,
  P2PTransport,
  P2PTransportRequestOptions,
} from "../../packages/p2p/index.js";

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
      bytes: response.status === 200 ? Buffer.from(await response.arrayBuffer()) : undefined,
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
