/**
 * OpenStore Cryptography Module
 *
 * Responsible for:
 * - Encrypting storage chunks
 * - Decrypting storage chunks
 * - Generating encryption keys
 * - Protecting chunk confidentiality and integrity
 *
 * MVP algorithm:
 * AES-256-GCM
 *
 * Architectural guarantees:
 * - Encryption happens client-side; storage nodes only ever see
 *   the versioned {@link EncryptedChunk} (iv/ciphertext/authTag).
 * - Plaintext and encryption keys are never sent to storage nodes
 *   (enforced by keeping this package dependency-free and not
 *   performing any network I/O here).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export const CRYPTO_VERSION = 1;

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const AUTH_TAG_BYTES = 16;

const ALGORITHM = "aes-256-gcm";

/**
 * Versioned encrypted representation of a single storage chunk.
 * Each chunk is independently encrypted with a fresh random IV.
 */
export interface EncryptedChunk {
  version: number;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}

/**
 * Generate a fresh random 256-bit (32-byte) encryption key.
 */
export function generateEncryptionKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

/**
 * Encrypt a single chunk with AES-256-GCM.
 *
 * @param plaintext Chunk plaintext bytes (may be empty).
 * @param key 32-byte encryption key from {@link generateEncryptionKey}.
 * @returns Versioned encrypted chunk with a fresh random 12-byte IV.
 * @throws If the key is not exactly 32 bytes.
 */
export function encryptChunk(
  plaintext: Uint8Array,
  key: Uint8Array,
): EncryptedChunk {
  assertValidKey(key);
  if (!(plaintext instanceof Uint8Array)) {
    throw new TypeError("plaintext must be a Uint8Array");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(key), iv);

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: CRYPTO_VERSION,
    iv: new Uint8Array(iv),
    ciphertext: new Uint8Array(ciphertext),
    authTag: new Uint8Array(authTag),
  };
}

/**
 * Decrypt a single chunk encrypted with {@link encryptChunk}.
 *
 * Authentication failures (tampered ciphertext/authTag or wrong key)
 * throw, so callers must treat throws as rejection.
 *
 * @param encrypted Versioned encrypted chunk.
 * @param key 32-byte encryption key used at encryption time.
 * @returns Original plaintext bytes.
 * @throws If the version is unsupported, the key/shape is invalid,
 *         or GCM authentication fails.
 */
export function decryptChunk(
  encrypted: EncryptedChunk,
  key: Uint8Array,
): Uint8Array {
  assertValidKey(key);
  if (!encrypted || typeof encrypted !== "object") {
    throw new TypeError("encrypted chunk must be an object");
  }
  if (encrypted.version !== CRYPTO_VERSION) {
    throw new Error(`unsupported crypto version: ${encrypted.version}`);
  }
  if (!(encrypted.iv instanceof Uint8Array) || encrypted.iv.length !== IV_BYTES) {
    throw new Error(`iv must be exactly ${IV_BYTES} bytes`);
  }
  if (
    !(encrypted.authTag instanceof Uint8Array) ||
    encrypted.authTag.length !== AUTH_TAG_BYTES
  ) {
    throw new Error(`authTag must be exactly ${AUTH_TAG_BYTES} bytes`);
  }
  if (!(encrypted.ciphertext instanceof Uint8Array)) {
    throw new TypeError("ciphertext must be a Uint8Array");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    Buffer.from(key),
    Buffer.from(encrypted.iv),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext)),
    decipher.final(),
  ]);
  return new Uint8Array(plaintext);
}

function assertValidKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error(`encryption key must be exactly ${KEY_BYTES} bytes`);
  }
}
