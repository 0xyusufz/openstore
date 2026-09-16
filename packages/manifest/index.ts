/**
 * OpenStore Manifest Module
 *
 * Responsible for:
 * - Describing an uploaded file as a versioned manifest
 * - Encoding encrypted chunks into storable piece bytes
 * - Decoding stored piece bytes back into encrypted chunks
 * - Deriving content-addressed piece IDs (SHA-256)
 *
 * MVP notes:
 * - Manifests are returned to the caller, never persisted here.
 * - Encryption keys are never part of the manifest; inputs carrying
 *   key material are rejected.
 *
 * Stored piece format (v1, JSON envelope, UTF-8 bytes):
 * `{"version":1,"iv":"<base64>","ciphertext":"<base64>","authTag":"<base64>"}`
 */

import { createHash, randomBytes } from "crypto";
import { AUTH_TAG_BYTES, CRYPTO_VERSION, IV_BYTES } from "../crypto/index.js";
import type { EncryptedChunk } from "../crypto/index.js";

export const MANIFEST_VERSION = 1;

const SHA256_HEX_LENGTH = 64;
const FILE_ID_BYTES = 16;

/**
 * Metadata for a single chunk of an uploaded file.
 */
export interface ManifestChunk {
  index: number;
  pieceId: string;
  plaintextHash: string;
  plaintextSize: number;
  encryptedSize: number;
  nodeIds: string[];
}

/**
 * Versioned description of an uploaded file. Contains no key material.
 */
export interface FileManifest {
  version: number;
  fileId: string;
  filename: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  cryptoVersion: number;
  chunks: ManifestChunk[];
  pieceIds: string[];
  nodeIds: string[];
}

/**
 * Input for {@link buildManifest}; `pieceIds`/`nodeIds` are derived.
 */
export interface BuildManifestInput {
  fileId: string;
  filename: string;
  size: number;
  chunkSize: number;
  cryptoVersion: number;
  chunks: ManifestChunk[];
}

/**
 * Build a validated file manifest, deriving ordered `pieceIds` and the
 * union of involved `nodeIds` from the chunk metadata.
 *
 * @param input Manifest fields plus per-chunk metadata.
 * @returns Versioned manifest.
 * @throws If fields are invalid, chunks are not complete/ordered, or
 *         key material is present.
 */
export function buildManifest(input: BuildManifestInput): FileManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }
  const record = input as unknown as Record<string, unknown>;
  if ("key" in record || "encryptionKey" in record) {
    throw new Error("manifests never contain encryption keys");
  }
  if (typeof input.fileId !== "string" || input.fileId === "") {
    throw new TypeError("fileId must be a non-empty string");
  }
  if (typeof input.filename !== "string" || input.filename === "") {
    throw new TypeError("filename must be a non-empty string");
  }
  assertNonNegativeInteger(input.size, "size");
  assertPositiveInteger(input.chunkSize, "chunkSize");
  assertPositiveInteger(input.cryptoVersion, "cryptoVersion");
  if (!Array.isArray(input.chunks)) {
    throw new TypeError("chunks must be an array");
  }

  for (let position = 0; position < input.chunks.length; position += 1) {
    const chunk = input.chunks[position] as ManifestChunk;
    if (!chunk || typeof chunk !== "object") {
      throw new Error(`chunk at position ${position} must be an object`);
    }
    if (chunk.index !== position) {
      throw new Error(
        `chunks must be complete and in ascending order: expected index ${position}, got ${chunk.index}`,
      );
    }
    assertSha256Hex(chunk.pieceId, `chunk ${position} pieceId`);
    assertSha256Hex(chunk.plaintextHash, `chunk ${position} plaintextHash`);
    assertPositiveInteger(chunk.plaintextSize, `chunk ${position} plaintextSize`);
    assertPositiveInteger(chunk.encryptedSize, `chunk ${position} encryptedSize`);
    if (!Array.isArray(chunk.nodeIds) || chunk.nodeIds.length === 0) {
      throw new Error(`chunk ${position} must list at least one node ID`);
    }
    if (new Set(chunk.nodeIds).size !== chunk.nodeIds.length) {
      throw new Error(`chunk ${position} contains duplicate replica node IDs`);
    }
    for (const nodeId of chunk.nodeIds) {
      if (typeof nodeId !== "string" || nodeId === "") {
        throw new Error(`chunk ${position} has an invalid node ID`);
      }
    }
  }

  const pieceIds = input.chunks.map((chunk) => chunk.pieceId);
  const seen = new Set<string>();
  const nodeIds: string[] = [];
  for (const chunk of input.chunks) {
    for (const nodeId of chunk.nodeIds) {
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        nodeIds.push(nodeId);
      }
    }
  }

  return {
    version: MANIFEST_VERSION,
    fileId: input.fileId,
    filename: input.filename,
    size: input.size,
    chunkSize: input.chunkSize,
    totalChunks: input.chunks.length,
    cryptoVersion: input.cryptoVersion,
    chunks: input.chunks.map((chunk) => ({ ...chunk, nodeIds: [...chunk.nodeIds] })),
    pieceIds,
    nodeIds,
  };
}

/**
 * Encode an encrypted chunk into storable piece bytes (v1 JSON envelope).
 *
 * @param encrypted Encrypted chunk from the crypto module.
 * @returns Opaque piece bytes whose SHA-256 is the piece ID.
 * @throws If the chunk shape or version is invalid.
 */
export function encodeEncryptedPiece(encrypted: EncryptedChunk): Buffer {
  if (!encrypted || typeof encrypted !== "object") {
    throw new TypeError("encrypted chunk must be an object");
  }
  if (encrypted.version !== CRYPTO_VERSION) {
    throw new Error(`unsupported crypto version: ${encrypted.version}`);
  }
  if (!(encrypted.iv instanceof Uint8Array) || encrypted.iv.length !== IV_BYTES) {
    throw new Error(`iv must be exactly ${IV_BYTES} bytes`);
  }
  if (!(encrypted.ciphertext instanceof Uint8Array)) {
    throw new TypeError("ciphertext must be a Uint8Array");
  }
  if (
    !(encrypted.authTag instanceof Uint8Array) ||
    encrypted.authTag.length !== AUTH_TAG_BYTES
  ) {
    throw new Error(`authTag must be exactly ${AUTH_TAG_BYTES} bytes`);
  }

  return Buffer.from(
    JSON.stringify({
      version: CRYPTO_VERSION,
      iv: Buffer.from(encrypted.iv).toString("base64"),
      ciphertext: Buffer.from(encrypted.ciphertext).toString("base64"),
      authTag: Buffer.from(encrypted.authTag).toString("base64"),
    }),
    "utf8",
  );
}

/**
 * Decode stored piece bytes back into an encrypted chunk.
 *
 * @param pieceBytes Bytes produced by {@link encodeEncryptedPiece}.
 * @returns The encrypted chunk.
 * @throws If the encoding or version is invalid.
 */
export function decodeEncryptedPiece(pieceBytes: Buffer): EncryptedChunk {
  if (!Buffer.isBuffer(pieceBytes)) {
    throw new TypeError("piece bytes must be a Buffer");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(pieceBytes.toString("utf8"));
  } catch {
    throw new Error("invalid encrypted piece encoding");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid encrypted piece encoding");
  }
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== CRYPTO_VERSION) {
    throw new Error(`unsupported crypto version: ${record["version"]}`);
  }
  const iv = decodeBase64Field(record["iv"], "iv");
  const ciphertext = decodeBase64Field(record["ciphertext"], "ciphertext");
  const authTag = decodeBase64Field(record["authTag"], "authTag");
  if (iv.length !== IV_BYTES) {
    throw new Error(`iv must be exactly ${IV_BYTES} bytes`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`authTag must be exactly ${AUTH_TAG_BYTES} bytes`);
  }
  return {
    version: CRYPTO_VERSION,
    iv: new Uint8Array(iv),
    ciphertext: new Uint8Array(ciphertext),
    authTag: new Uint8Array(authTag),
  };
}

/**
 * Derive the content-addressed piece ID for stored piece bytes.
 *
 * @param pieceBytes Encoded piece bytes.
 * @returns Lowercase SHA-256 hex digest.
 * @throws If the input is not a Buffer.
 */
export function hashPieceId(pieceBytes: Buffer): string {
  if (!Buffer.isBuffer(pieceBytes)) {
    throw new TypeError("piece bytes must be a Buffer");
  }
  return createHash("sha256").update(pieceBytes).digest("hex");
}

/**
 * Generate a random file ID (16 bytes, lowercase hex).
 *
 * @returns Unique file identifier.
 */
export function generateFileId(): string {
  return randomBytes(FILE_ID_BYTES).toString("hex");
}

function decodeBase64Field(value: unknown, name: string): Buffer {
  if (typeof value !== "string") {
    throw new Error(`invalid encrypted piece encoding: bad ${name}`);
  }
  return Buffer.from(value, "base64");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertSha256Hex(value: string, name: string): void {
  if (typeof value !== "string" || value.length !== SHA256_HEX_LENGTH) {
    throw new Error(`${name} must be a SHA-256 hex string`);
  }
}
