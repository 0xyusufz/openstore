import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createIdentity, signMessage, verifyMessage } from "./index.js";
import { loadIdentity, saveIdentity } from "./keystore.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openstore-keystore-"));
}

/**
 * Per-run generated test-only keystore input. Random by design: no
 * hardcoded credential ever appears in this file, and values never
 * leave the test.
 */
function randomTestInput(): string {
  return `test-${randomBytes(12).toString("hex")}`;
}

describe("encrypted local identity keystore (OPENSTORE-008)", () => {
  it("1. save → load round-trip preserves identity", async () => {
    const dir = await tempDir();
    try {
      const original = createIdentity();
      const filePath = join(dir, "identity.json");
      const input = randomTestInput();
      await saveIdentity(original, input, filePath);
      const loaded = await loadIdentity(input, filePath);
      expect(loaded.version).toBe(original.version);
      expect(loaded.publicKey.equals(original.publicKey)).toBe(true);
      expect(loaded.privateKey.equals(original.privateKey)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. loaded identity can sign and verify", async () => {
    const dir = await tempDir();
    try {
      const original = createIdentity();
      const filePath = join(dir, "identity.json");
      const input = randomTestInput();
      await saveIdentity(original, input, filePath);
      const loaded = await loadIdentity(input, filePath);
      const msg = new TextEncoder().encode("keystore sign test");
      const sig = signMessage(loaded.privateKey, msg);
      expect(verifyMessage(loaded.publicKey, msg, sig)).toBe(true);
      // Cross-verify with original public key
      expect(verifyMessage(original.publicKey, msg, sig)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("3. wrong password fails", async () => {
    const dir = await tempDir();
    try {
      const id = createIdentity();
      const filePath = join(dir, "identity.json");
      const right = randomTestInput();
      let wrong = randomTestInput();
      if (wrong === right) wrong += "0";
      await saveIdentity(id, right, filePath);
      await expect(loadIdentity(wrong, filePath)).rejects.toThrow(/wrong password|corrupted|tampered|decrypt/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("4. tampered ciphertext fails", async () => {
    const dir = await tempDir();
    try {
      const id = createIdentity();
      const filePath = join(dir, "identity.json");
      const input = randomTestInput();
      await saveIdentity(id, input, filePath);
      const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      const ct = Buffer.from(raw["encryptedPrivateKey"] as string, "base64");
      ct[0] = (ct[0] as number) ^ 0xff;
      raw["encryptedPrivateKey"] = ct.toString("base64");
      await writeFile(filePath, JSON.stringify(raw));
      await expect(loadIdentity(input, filePath)).rejects.toThrow(/corrupted|tampered|decrypt/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("5. tampered authentication tag/metadata fails", async () => {
    const dir = await tempDir();
    try {
      const id = createIdentity();
      const filePath = join(dir, "identity.json");
      const input = randomTestInput();
      await saveIdentity(id, input, filePath);

      // Tamper auth tag
      const raw1 = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      const tag = Buffer.from(raw1["authTag"] as string, "base64");
      tag[0] = (tag[0] as number) ^ 0xff;
      raw1["authTag"] = tag.toString("base64");
      await writeFile(filePath, JSON.stringify(raw1));
      await expect(loadIdentity(input, filePath)).rejects.toThrow(/corrupted|tampered|decrypt/i);

      // Tamper KDF salt (metadata)
      await saveIdentity(id, input, filePath);
      const raw2 = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      const kdf = raw2["kdf"] as Record<string, unknown>;
      const salt = Buffer.from(kdf["salt"] as string, "base64");
      salt[0] = (salt[0] as number) ^ 0xff;
      kdf["salt"] = salt.toString("base64");
      await writeFile(filePath, JSON.stringify(raw2));
      await expect(loadIdentity(input, filePath)).rejects.toThrow(/corrupted|tampered|decrypt|wrong password/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("6. recovery phrase is not present in keystore output", async () => {
    const dir = await tempDir();
    try {
      const id = createIdentity();
      const filePath = join(dir, "identity.json");
      await saveIdentity(id, randomTestInput(), filePath);
      const content = await readFile(filePath, "utf8");
      for (const word of id.recoveryPhrase) {
        // Check phrase words are not embedded as plain text (beyond random overlap)
        // The full phrase string must not appear
        expect(content).not.toContain(id.recoveryPhrase.join(" "));
      }
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const serialized = JSON.stringify(parsed).toLowerCase();
      expect(serialized).not.toContain("recovery");
      expect(serialized).not.toContain("mnemonic");
      expect(serialized).not.toContain("phrase");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("7. plaintext private key is not present in keystore output", async () => {
    const dir = await tempDir();
    try {
      const id = createIdentity();
      const filePath = join(dir, "identity.json");
      await saveIdentity(id, randomTestInput(), filePath);
      const content = await readFile(filePath, "utf8");
      const privateKeyB64 = id.privateKey.toString("base64");
      const privateKeyHex = id.privateKey.toString("hex");
      expect(content).not.toContain(privateKeyB64);
      expect(content).not.toContain(privateKeyHex);
      // Also check raw bytes not present
      const rawContent = await readFile(filePath);
      expect(rawContent.indexOf(id.privateKey)).toBe(-1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("8. repeated saves use different salt/IV", async () => {
    const dir = await tempDir();
    try {
      const id = createIdentity();
      const file1 = join(dir, "a.json");
      const file2 = join(dir, "b.json");
      const shared = randomTestInput();
      await saveIdentity(id, shared, file1);
      await saveIdentity(id, shared, file2);
      const raw1 = JSON.parse(await readFile(file1, "utf8")) as Record<string, unknown>;
      const raw2 = JSON.parse(await readFile(file2, "utf8")) as Record<string, unknown>;
      expect(raw1["iv"]).not.toBe(raw2["iv"]);
      const kdf1 = raw1["kdf"] as Record<string, unknown>;
      const kdf2 = raw2["kdf"] as Record<string, unknown>;
      expect(kdf1["salt"]).not.toBe(kdf2["salt"]);
      expect(raw1["encryptedPrivateKey"]).not.toBe(raw2["encryptedPrivateKey"]);
      // Both still load correctly
      const loaded1 = await loadIdentity(shared, file1);
      const loaded2 = await loadIdentity(shared, file2);
      expect(loaded1.privateKey.equals(id.privateKey)).toBe(true);
      expect(loaded2.privateKey.equals(id.privateKey)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("9. missing/malformed keystore fails clearly", async () => {
    const dir = await tempDir();
    try {
      const input = randomTestInput();
      // Missing file
      await expect(loadIdentity(input, join(dir, "nonexistent.json"))).rejects.toThrow(/failed to read|not found|no such file/i);

      // Malformed JSON
      const badJson = join(dir, "bad.json");
      await writeFile(badJson, "not json at all{{{");
      await expect(loadIdentity(input, badJson)).rejects.toThrow(/malformed|invalid JSON/i);

      // Valid JSON but missing required fields
      const incomplete = join(dir, "incomplete.json");
      await writeFile(incomplete, JSON.stringify({ version: 1 }));
      await expect(loadIdentity(input, incomplete)).rejects.toThrow(/malformed/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses restrictive file permissions on supported platforms", async () => {
    if (process.platform === "win32") return;
    const dir = await tempDir();
    try {
      const id = createIdentity();
      const filePath = join(dir, "identity.json");
      await saveIdentity(id, randomTestInput(), filePath);
      const s = await stat(filePath);
      // Check that group/other have no permissions (0o077 = group+other bits)
      expect(s.mode & 0o077).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects keystores whose permissions are widened", async () => {
    if (process.platform === "win32") return;
    const dir = await tempDir();
    try {
      const filePath = join(dir, "identity.json");
      const password = randomTestInput();
      await saveIdentity(createIdentity(), password, filePath);
      await chmod(filePath, 0o644);
      await expect(loadIdentity(password, filePath)).rejects.toThrow(/unsafe permissions/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
