/**
 * DEK Vault Tests (OPENSTORE-028)
 *
 * Unit tests for the server-side file-key store: round-trip, validation,
 * restrictive permissions, and fail-closed malformed handling.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { KEY_BYTES } from "../../packages/crypto/index.js";
import { createDekStore } from "./dekstore.js";

async function tempVaultPath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openstore-dekstore-"));
  return { dir, path: join(dir, "vault.deks.json") };
}

describe("dek vault (OPENSTORE-028)", () => {
  it("saves and loads a DEK round-trip", async () => {
    const { dir, path } = await tempVaultPath();
    try {
      const store = createDekStore({ path });
      const dek = randomBytes(KEY_BYTES);
      await store.saveDek("file-abc_123", dek);
      const loaded = await store.loadDek("file-abc_123");
      expect(loaded?.equals(dek)).toBe(true);
      expect(await store.loadDek("file-missing")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes with restrictive permissions", async () => {
    const { dir, path } = await tempVaultPath();
    try {
      const store = createDekStore({ path });
      await store.saveDek("file-abc", randomBytes(KEY_BYTES));
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad file IDs and bad DEKs", async () => {
    const { dir, path } = await tempVaultPath();
    try {
      const store = createDekStore({ path });
      await expect(store.saveDek("../../etc", randomBytes(KEY_BYTES))).rejects.toThrow(/fileId/i);
      await expect(store.saveDek("ok-id", randomBytes(16))).rejects.toThrow(/32 bytes/i);
      await expect(store.saveDek("ok-id", "not-bytes" as never)).rejects.toThrow(/dek/i);
      await expect(store.loadDek("../x")).rejects.toThrow(/fileId/i);
      expect(() => createDekStore({ path: "" })).toThrow(/path/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed vault files", async () => {
    const { dir, path } = await tempVaultPath();
    try {
      const store = createDekStore({ path });
      await writeFile(path, "not json {{{", { mode: 0o600 });
      await expect(store.loadDek("file-abc")).rejects.toThrow(/malformed/i);
      await writeFile(path, JSON.stringify({ version: 1, deks: { "file-abc": "!!!not-base64!!!" } }), { mode: 0o600 });
      await expect(store.loadDek("file-abc")).rejects.toThrow(/malformed|wrong length/i);
      await writeFile(path, JSON.stringify({ version: 999, deks: {} }), { mode: 0o600 });
      await expect(store.loadDek("file-abc")).rejects.toThrow(/malformed/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes entries", async () => {
    const { dir, path } = await tempVaultPath();
    try {
      const store = createDekStore({ path });
      await store.saveDek("file-abc", randomBytes(KEY_BYTES));
      expect(await store.deleteDek("file-abc")).toBe(true);
      expect(await store.loadDek("file-abc")).toBeUndefined();
      expect(await store.deleteDek("file-abc")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
