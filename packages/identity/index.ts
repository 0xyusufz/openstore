/**
 * OpenStore Identity Module (OPENSTORE-007)
 *
 * Responsible for:
 * - Generating cryptographic identities (Ed25519 keypairs)
 * - Creating 12-word recovery phrases
 * - Deriving identity private keys deterministically from phrases
 * - Signing and verifying messages
 *
 * Key derivation:
 * HKDF-SHA256 over the phrase bytes with fixed salt and info strings,
 * producing a 32-byte Ed25519 seed. This is a standard, well-defined KDF.
 *
 * Architectural guarantees:
 * - Private keys are never sent to storage nodes.
 * - Recovery phrases are never stored in plaintext by OpenStore.
 * - Identity keys are independent of file encryption DEKs.
 * - The same recovery phrase always produces the same identity.
 */

import { createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, verify } from "crypto";
import { WORDLIST, WORD_COUNT } from "./wordlist.js";

export const IDENTITY_VERSION = 1;

const ENTROPY_BITS = 128;
const ENTROPY_BYTES = ENTROPY_BITS / 8;
const WORDS_PER_PHRASE = 12;
const CHECKSUM_BITS = 4;

const HKDF_SALT = "openstore-identity-salt-v1";
const HKDF_INFO = "openstore-identity-key-v1";

const DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * A cryptographic identity with Ed25519 keypair.
 * The private key must stay client-side and never be sent to nodes.
 */
export interface Identity {
  version: number;
  publicKey: Buffer;
  privateKey: Buffer;
  recoveryPhrase: string[];
}

/**
 * Create a new identity with a fresh random recovery phrase.
 *
 * 128 bits of secure randomness → 12-word phrase (OpenStore Recovery
 * Phrase v1: 4-bit SHA-256 checksum appended, then 12 × 11-bit words
 * into the 2048-word list).
 *
 * @returns Identity with keypair and recovery phrase.
 */
export function createIdentity(): Identity {
  const entropy = randomBytes(ENTROPY_BYTES);
  const phrase = entropyToPhrase(entropy);
  const { publicKey, privateKey } = deriveKeyPair(phrase);
  return {
    version: IDENTITY_VERSION,
    publicKey,
    privateKey,
    recoveryPhrase: phrase,
  };
}

/**
 * Recover an identity from a 12-word recovery phrase.
 *
 * The phrase is validated (length, wordlist membership, checksum) and
 * the Ed25519 keypair is deterministically derived via HKDF.
 *
 * @param recoveryPhrase Array of 12 lowercase words from the wordlist.
 * @returns Identity with keypair (recoveryPhrase is the input phrase).
 * @throws If the phrase is invalid or the checksum fails.
 */
export function recoverIdentity(recoveryPhrase: string[]): Identity {
  const phrase = validatePhrase(recoveryPhrase);
  const { publicKey, privateKey } = deriveKeyPair(phrase);
  return {
    version: IDENTITY_VERSION,
    publicKey,
    privateKey,
    recoveryPhrase: phrase,
  };
}

/**
 * Sign a message with an Ed25519 private key.
 *
 * @param privateKey Ed25519 private key (DER PKCS#8 buffer).
 * @param message Message bytes to sign.
 * @returns 64-byte Ed25519 signature.
 * @throws If the key is invalid.
 */
export function signMessage(
  privateKey: Buffer,
  message: Uint8Array,
): Buffer {
  const key = asPrivateKey(privateKey);
  return sign(null, Buffer.from(message), key);
}

/**
 * Verify an Ed25519 signature.
 *
 * @param publicKey Ed25519 public key (DER SPKI buffer).
 * @param message Original message bytes.
 * @param signature 64-byte Ed25519 signature.
 * @returns True if valid, false otherwise (never throws).
 */
export function verifyMessage(
  publicKey: Buffer,
  message: Uint8Array,
  signature: Buffer,
): boolean {
  try {
    const key = asPublicKey(publicKey);
    return verify(null, Buffer.from(message), key, signature);
  } catch {
    return false;
  }
}

function deriveKeyPair(phrase: string[]): {
  publicKey: Buffer;
  privateKey: Buffer;
} {
  const phraseBytes = Buffer.from(phrase.join(" "), "utf8");
  const seed = Buffer.from(
    hkdfSync("sha256", phraseBytes, HKDF_SALT, HKDF_INFO, 32),
  );
  try {
    const pkcs8 = Buffer.concat([DER_PREFIX, seed]);
    const privateKeyObj = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const publicKeyObj = createPublicKey(privateKeyObj);
    return {
      publicKey: publicKeyObj.export({ format: "der", type: "spki" }) as Buffer,
      privateKey: pkcs8,
    };
  } finally {
    phraseBytes.fill(0);
    seed.fill(0);
  }
}

function entropyToPhrase(entropy: Buffer): string[] {
  // Convert entropy to bits: 128 bits
  const bits = entropyToBits(entropy);
  // Append 4-bit checksum (first 4 bits of SHA-256 of entropy)
  const hash = hashBytes(entropy);
  const firstByte = hash.subarray(0, 1)[0] as number;
  const checksumBits = firstByte.toString(2).padStart(8, "0").slice(0, CHECKSUM_BITS);
  const allBits = bits + checksumBits;
  // Split into 12 × 11-bit indices
  const words: string[] = [];
  for (let i = 0; i < WORDS_PER_PHRASE; i += 1) {
    const chunk = allBits.slice(i * 11, (i + 1) * 11);
    const index = parseInt(chunk, 2);
    words.push(WORDLIST[index] as string);
  }
  return words;
}

function phraseToEntropy(phrase: string[]): Buffer {
  // Concatenate 11-bit indices into bits
  let bits = "";
  for (const word of phrase) {
    const index = WORDLIST.indexOf(word);
    bits += index.toString(2).padStart(11, "0");
  }
  // Split: 128 bits entropy + 4 bits checksum
  const entropyBits = bits.slice(0, ENTROPY_BITS);
  const checksumBits = bits.slice(ENTROPY_BITS, ENTROPY_BITS + CHECKSUM_BITS);
  const entropy = bitsToBytes(entropyBits);
  // Verify checksum
  const hash = hashBytes(entropy);
  const firstByte = hash.subarray(0, 1)[0] as number;
  const expected = firstByte.toString(2).padStart(8, "0").slice(0, CHECKSUM_BITS);
  if (checksumBits !== expected) {
    throw new Error("invalid recovery phrase: checksum mismatch");
  }
  return entropy;
}

function validatePhrase(input: string[]): string[] {
  if (!Array.isArray(input) || input.length !== WORDS_PER_PHRASE) {
    throw new Error(`recovery phrase must have exactly ${WORDS_PER_PHRASE} words`);
  }
  for (let i = 0; i < input.length; i += 1) {
    if (typeof input[i] !== "string" || WORDLIST.indexOf(input[i] as string) === -1) {
      throw new Error(`invalid word at position ${i + 1}: "${input[i]}"`);
    }
  }
  phraseToEntropy(input);
  return input.map((w) => w.toLowerCase());
}

function asPrivateKey(key: Buffer): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({ key, format: "der", type: "pkcs8" });
}

function asPublicKey(key: Buffer): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key, format: "der", type: "spki" });
}

function entropyToBits(buf: Buffer): string {
  return Array.from(buf)
    .map((b) => b.toString(2).padStart(8, "0"))
    .join("");
}

function bitsToBytes(bits: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hashBytes(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}
