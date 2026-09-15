import { describe, expect, it } from "vitest";
import {
  decryptChunk,
  encryptChunk,
  generateEncryptionKey,
} from "./index.js";

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("crypto foundation (OPENSTORE-001)", () => {
  it("encrypt → decrypt returns original plaintext", () => {
    const key = generateEncryptionKey();
    const plaintext = toBytes("hello openstore chunk");

    const encrypted = encryptChunk(plaintext, key);
    const decrypted = decryptChunk(encrypted, key);

    expect(fromBytes(decrypted)).toBe("hello openstore chunk");
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
  });

  it("generated encryption key is exactly 32 bytes", () => {
    const key = generateEncryptionKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    expect(key.byteLength).toBe(32);
  });

  it("modified ciphertext is rejected", () => {
    const key = generateEncryptionKey();
    const encrypted = encryptChunk(toBytes("tamper me"), key);

    const tampered = {
      ...encrypted,
      ciphertext: Uint8Array.from(encrypted.ciphertext),
    };
    tampered.ciphertext[0] = (tampered.ciphertext[0] as number) ^ 0xff;

    expect(() => decryptChunk(tampered, key)).toThrow();
  });

  it("wrong encryption key is rejected", () => {
    const key = generateEncryptionKey();
    const wrongKey = generateEncryptionKey();
    const encrypted = encryptChunk(toBytes("secret chunk"), key);

    expect(() => decryptChunk(encrypted, wrongKey)).toThrow();
  });
});
