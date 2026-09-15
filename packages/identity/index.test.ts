import { describe, expect, it } from "vitest";
import {
  createIdentity,
  recoverIdentity,
  signMessage,
  verifyMessage,
} from "./index.js";
import { WORDLIST, WORD_COUNT } from "./wordlist.js";

describe("wordlist (OPENSTORE-007)", () => {
  it("has exactly 2048 unique lowercase words", () => {
    expect(WORD_COUNT).toBe(2048);
    expect(WORDLIST.length).toBe(2048);
    expect(new Set(WORDLIST).size).toBe(2048);
    expect(WORDLIST.every((w) => /^[a-z]+$/.test(w))).toBe(true);
  });
});

describe("cryptographic identity (OPENSTORE-007)", () => {
  it("1. create identity returns valid keypair and phrase", () => {
    const id = createIdentity();
    expect(id.version).toBe(1);
    expect(id.publicKey).toBeInstanceOf(Buffer);
    expect(id.privateKey).toBeInstanceOf(Buffer);
    expect(id.recoveryPhrase).toHaveLength(12);
    expect(id.recoveryPhrase.every((w) => WORDLIST.includes(w))).toBe(true);
  });

  it("2. public/private key pair works for sign and verify", () => {
    const id = createIdentity();
    const msg = new TextEncoder().encode("openstore test");
    const sig = signMessage(id.privateKey, msg);
    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64);
    expect(verifyMessage(id.publicKey, msg, sig)).toBe(true);
  });

  it("3. sign + verify succeeds with known message", () => {
    const id = createIdentity();
    const msg = new TextEncoder().encode("hello decentralized storage");
    const sig = signMessage(id.privateKey, msg);
    expect(verifyMessage(id.publicKey, msg, sig)).toBe(true);
  });

  it("4. tampered message fails verification", () => {
    const id = createIdentity();
    const msg = new TextEncoder().encode("original message");
    const sig = signMessage(id.privateKey, msg);
    const tampered = new TextEncoder().encode("tampered message");
    expect(verifyMessage(id.publicKey, tampered, sig)).toBe(false);
  });

  it("5. wrong public key fails verification", () => {
    const id1 = createIdentity();
    const id2 = createIdentity();
    const msg = new TextEncoder().encode("test message");
    const sig = signMessage(id1.privateKey, msg);
    expect(verifyMessage(id2.publicKey, msg, sig)).toBe(false);
  });

  it("6. same recovery phrase recovers same identity", () => {
    const id1 = createIdentity();
    const id2 = recoverIdentity(id1.recoveryPhrase);
    expect(id1.publicKey.equals(id2.publicKey)).toBe(true);
    expect(id1.privateKey.equals(id2.privateKey)).toBe(true);

    // Signing with recovered key produces valid signature for original public key
    const msg = new TextEncoder().encode("recovery test");
    const sig = signMessage(id2.privateKey, msg);
    expect(verifyMessage(id1.publicKey, msg, sig)).toBe(true);
  });

  it("7. invalid recovery phrase fails", () => {
    // Too short
    expect(() => recoverIdentity(["one", "two"])).toThrow();
    // Invalid word
    expect(() =>
      recoverIdentity([
        "abandon", "abandon", "abandon", "abandon",
        "abandon", "abandon", "abandon", "abandon",
        "abandon", "abandon", "abandon", "notaword",
      ]),
    ).toThrow();
    // Bad checksum
    expect(() =>
      recoverIdentity([
        "abandon", "abandon", "abandon", "abandon",
        "abandon", "abandon", "abandon", "abandon",
        "abandon", "abandon", "abandon", "about",
      ]),
    ).toThrow();
  });

  it("8. generated recovery phrases are not duplicated", () => {
    const phrases = new Set<string>();
    const count = 50;
    for (let i = 0; i < count; i += 1) {
      const id = createIdentity();
      const key = id.recoveryPhrase.join(" ");
      expect(phrases.has(key)).toBe(false);
      phrases.add(key);
    }
    expect(phrases.size).toBe(count);
  });
});
