/**
 * OpenStore Encrypted Identity Keystore (OPENSTORE-008)
 *
 * Responsible for:
 * - Persisting an identity's private key encrypted on disk
 * - Deriving the encryption key from a password via scrypt
 * - Encrypting the private key with AES-256-GCM
 *
 * Architectural guarantees:
 * - Recovery phrase is never stored.
 * - Private key plaintext is never stored on disk.
 * - Each save uses a fresh random salt and IV.
 * - Keystore files are created with restrictive 0o600 permissions.
 * - Wrong password and any tampering are detected via auth tag / validation.
 */

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes, scryptSync } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { Identity } from "./index.js";

export const KEYSTORE_VERSION = 1;

const SALT_BYTES = 32;
const IV_BYTES = 12;
const KEY_LEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

interface EncryptedKeystore {
  version: number;
  identityVersion: number;
  publicKey: string;
  encryptedPrivateKey: string;
  iv: string;
  authTag: string;
  kdf: {
    algorithm: "scrypt";
    salt: string;
    N: number;
    r: number;
    p: number;
    keyLen: number;
  };
  encryption: {
    algorithm: "aes-256-gcm";
  };
}

/**
 * Persist an identity to disk with password-based encryption.
 *
 * @param identity Identity to save (recovery phrase is ignored / never stored).
 * @param password Password to derive the encryption key (never logged).
 * @param filePath Absolute or relative path for the keystore JSON file.
 * @throws If identity or password is invalid.
 */
export async function saveIdentity(
  identity: Identity,
  password: string,
  filePath: string,
): Promise<void> {
  if (!identity || typeof identity !== "object") {
    throw new TypeError("identity must be an object");
  }
  if (typeof identity.version !== "number" || !Number.isInteger(identity.version)) {
    throw new TypeError("identity.version must be an integer");
  }
  if (!Buffer.isBuffer(identity.publicKey)) {
    throw new TypeError("identity.publicKey must be a Buffer");
  }
  if (!Buffer.isBuffer(identity.privateKey)) {
    throw new TypeError("identity.privateKey must be a Buffer");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("password must be a non-empty string");
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("filePath must be a non-empty string");
  }

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(identity.privateKey), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const keystore: EncryptedKeystore = {
    version: KEYSTORE_VERSION,
    identityVersion: identity.version,
    publicKey: identity.publicKey.toString("base64"),
    encryptedPrivateKey: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    kdf: {
      algorithm: "scrypt",
      salt: salt.toString("base64"),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLen: KEY_LEN,
    },
    encryption: {
      algorithm: "aes-256-gcm",
    },
  };

  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const content = JSON.stringify(keystore, null, 2);
  await writeFile(filePath, content, { mode: 0o600 });
}

/**
 * Load and decrypt an identity from disk.
 *
 * @param password Password used at save time.
 * @param filePath Path to the keystore JSON file.
 * @returns Reconstructed identity (recoveryPhrase is empty — never stored).
 * @throws If the password is wrong, file is missing/malformed, or data is tampered.
 */
export async function loadIdentity(
  password: string,
  filePath: string,
): Promise<Identity> {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("password must be a non-empty string");
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("filePath must be a non-empty string");
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`failed to read keystore: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("keystore is malformed: invalid JSON");
  }

  const ks = validateKeystore(parsed);

  const salt = Buffer.from(ks.kdf.salt, "base64");
  const iv = Buffer.from(ks.iv, "base64");
  const ciphertext = Buffer.from(ks.encryptedPrivateKey, "base64");
  const authTag = Buffer.from(ks.authTag, "base64");
  const storedPublicKey = Buffer.from(ks.publicKey, "base64");

  if (salt.length !== SALT_BYTES) {
    throw new Error("keystore is malformed: invalid salt length");
  }
  if (iv.length !== IV_BYTES) {
    throw new Error("keystore is malformed: invalid iv length");
  }
  if (authTag.length !== 16) {
    throw new Error("keystore is malformed: invalid auth tag length");
  }

  let key: Buffer;
  try {
    key = deriveKey(password, salt, ks.kdf.N, ks.kdf.r, ks.kdf.p, ks.kdf.keyLen);
  } catch (err) {
    throw new Error(`failed to derive key: ${(err as Error).message}`);
  }

  let privateKey: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("failed to decrypt keystore: wrong password or corrupted/tampered data");
  }

  // Verify decrypted private key yields the stored public key (detects tampered publicKey)
  try {
    const privObj = createPrivateKey({ key: privateKey, format: "der", type: "pkcs8" });
    const pubObj = createPublicKey(privObj);
    const derivedPub = pubObj.export({ format: "der", type: "spki" }) as Buffer;
    if (!derivedPub.equals(storedPublicKey)) {
      throw new Error("keystore public key does not match private key");
    }
  } catch (err) {
    if ((err as Error).message === "keystore public key does not match private key") {
      throw err;
    }
    throw new Error("failed to decrypt keystore: wrong password or corrupted/tampered data");
  }

  return {
    version: ks.identityVersion,
    publicKey: storedPublicKey,
    privateKey,
    recoveryPhrase: [],
  };
}

function deriveKey(
  password: string,
  salt: Buffer,
  N: number = SCRYPT_N,
  r: number = SCRYPT_R,
  p: number = SCRYPT_P,
  keyLen: number = KEY_LEN,
): Buffer {
  return scryptSync(password, salt, keyLen, { N, r, p }) as Buffer;
}

function validateKeystore(parsed: unknown): EncryptedKeystore {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("keystore is malformed: expected an object");
  }
  const o = parsed as Record<string, unknown>;
  if (o["version"] !== KEYSTORE_VERSION) {
    throw new Error(`unsupported keystore version: ${o["version"]}`);
  }
  if (typeof o["identityVersion"] !== "number" || !Number.isInteger(o["identityVersion"] as number)) {
    throw new Error("keystore is malformed: invalid identityVersion");
  }
  for (const field of ["publicKey", "encryptedPrivateKey", "iv", "authTag"] as const) {
    if (typeof o[field] !== "string" || (o[field] as string).length === 0) {
      throw new Error(`keystore is malformed: invalid ${field}`);
    }
  }
  if (!o["kdf"] || typeof o["kdf"] !== "object" || Array.isArray(o["kdf"])) {
    throw new Error("keystore is malformed: invalid kdf");
  }
  const kdf = o["kdf"] as Record<string, unknown>;
  if (kdf["algorithm"] !== "scrypt") {
    throw new Error("keystore is malformed: unsupported kdf algorithm");
  }
  if (typeof kdf["salt"] !== "string" || (kdf["salt"] as string).length === 0) {
    throw new Error("keystore is malformed: invalid kdf salt");
  }
  for (const field of ["N", "r", "p", "keyLen"] as const) {
    if (typeof kdf[field] !== "number" || !Number.isInteger(kdf[field] as number) || (kdf[field] as number) <= 0) {
      throw new Error(`keystore is malformed: invalid kdf ${field}`);
    }
  }
  if (!o["encryption"] || typeof o["encryption"] !== "object" || Array.isArray(o["encryption"])) {
    throw new Error("keystore is malformed: invalid encryption");
  }
  const enc = o["encryption"] as Record<string, unknown>;
  if (enc["algorithm"] !== "aes-256-gcm") {
    throw new Error("keystore is malformed: unsupported encryption algorithm");
  }
  return parsed as EncryptedKeystore;
}
