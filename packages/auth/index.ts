/**
 * OpenStore Auth Module (OPENSTORE-009)
 *
 * Provides Ed25519 request signing with replay protection.
 * Uses Node.js built-in crypto only, reusing the identity package.
 *
 * Signed payload format (utf8 bytes):
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH
 * where BODY_HASH is hex SHA-256 of the raw request body (empty → hash of zero bytes).
 */

import { createHash, randomBytes } from "crypto";
import { signMessage, verifyMessage } from "../identity/index.js";

export const AUTH_VERSION = 1;

export const PUBKEY_HEADER = "x-openstore-pubkey";
export const TIMESTAMP_HEADER = "x-openstore-timestamp";
export const NONCE_HEADER = "x-openstore-nonce";
export const SIGNATURE_HEADER = "x-openstore-signature";

export const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const NONCE_BYTES = 16;

export interface AuthHeaders extends Record<string, string> {
  [PUBKEY_HEADER]: string;
  [TIMESTAMP_HEADER]: string;
  [NONCE_HEADER]: string;
  [SIGNATURE_HEADER]: string;
}

export interface SignOptions {
  timestamp?: number;
  nonce?: string;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
}

/**
 * Hash body bytes to hex SHA-256.
 */
export function hashBody(body?: Buffer): string {
  const buf = body ?? Buffer.alloc(0);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Build canonical payload string to sign.
 */
export function canonicalPayload(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: string,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/**
 * Create signed auth headers for a request.
 *
 * @param identity Client or node identity (uses privateKey, exposes only publicKey)
 * @param method HTTP method
 * @param path Request path (e.g. "/pieces" or "/pieces/<id>")
 * @param body Raw request body bytes (for POST); undefined for GET/DELETE
 * @param opts Optional timestamp/nonce overrides (for testing)
 */
export function createAuthHeaders(
  identity: { publicKey: Buffer; privateKey: Buffer },
  method: string,
  path: string,
  body?: Buffer,
  opts: SignOptions = {},
): AuthHeaders {
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES).toString("hex");
  const bodyHash = hashBody(body);
  const payload = canonicalPayload(method, path, timestamp, nonce, bodyHash);
  const sig = signMessage(identity.privateKey, Buffer.from(payload, "utf8"));
  return {
    [PUBKEY_HEADER]: identity.publicKey.toString("base64"),
    [TIMESTAMP_HEADER]: timestamp,
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: sig.toString("base64"),
  };
}

/**
 * Verify auth headers from an incoming request.
 *
 * @param headers Lower-cased header map
 * @param method HTTP method
 * @param path Request path
 * @param body Raw body bytes
 * @param maxClockSkewMs Allowed clock skew
 * @param seenNonces Map of nonce -> expiry (for replay protection)
 */
export function verifyAuthHeaders(
  headers: Record<string, string | undefined>,
  method: string,
  path: string,
  body: Buffer | undefined,
  maxClockSkewMs: number,
  seenNonces: Map<string, number>,
): VerifyResult {
  const pubkeyB64 = headers[PUBKEY_HEADER];
  const timestampStr = headers[TIMESTAMP_HEADER];
  const nonce = headers[NONCE_HEADER];
  const sigB64 = headers[SIGNATURE_HEADER];

  const hasAny = pubkeyB64 !== undefined || timestampStr !== undefined || nonce !== undefined || sigB64 !== undefined;
  if (!hasAny) {
    return { valid: false, error: "missing auth" };
  }
  if (!pubkeyB64 || !timestampStr || !nonce || !sigB64) {
    return { valid: false, error: "malformed auth headers" };
  }

  // Validate timestamp
  const timestamp = Number(timestampStr);
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    return { valid: false, error: "invalid timestamp" };
  }
  const now = Date.now();
  if (Math.abs(now - timestamp) > maxClockSkewMs) {
    return { valid: false, error: "expired timestamp" };
  }

  // Validate nonce format (hex, 32 chars) and replay
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    return { valid: false, error: "invalid nonce" };
  }
  // Purge expired nonces
  for (const [k, exp] of seenNonces) {
    if (exp < now) seenNonces.delete(k);
  }
  if (seenNonces.has(nonce)) {
    return { valid: false, error: "replayed nonce" };
  }

  // Validate pubkey and signature are base64
  let pubkey: Buffer;
  let sig: Buffer;
  try {
    pubkey = Buffer.from(pubkeyB64, "base64");
    if (pubkey.length === 0) throw new Error("empty");
    // Validate it's a proper SPKI by trying to import (verifyMessage will do)
  } catch {
    return { valid: false, error: "invalid pubkey" };
  }
  try {
    sig = Buffer.from(sigB64, "base64");
    if (sig.length !== 64) throw new Error("bad length");
  } catch {
    return { valid: false, error: "invalid signature" };
  }

  const bodyHash = hashBody(body);
  const payload = canonicalPayload(method, path, timestampStr, nonce, bodyHash);
  const ok = verifyMessage(pubkey, Buffer.from(payload, "utf8"), sig);
  if (!ok) {
    return { valid: false, error: "invalid signature" };
  }

  // Record nonce with expiry = timestamp + skew (so replay window)
  seenNonces.set(nonce, timestamp + maxClockSkewMs);
  return { valid: true };
}
