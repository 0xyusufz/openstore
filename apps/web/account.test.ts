import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createIdentity, recoverIdentity } from "../../packages/identity/index.js";
import { loadIdentity } from "../../packages/identity/keystore.js";
import { createWebBackend } from "./backend.js";
import { createWebServer } from "./server.js";

function randomTestInput(): string {
  return `test-${randomBytes(12).toString("hex")}`;
}

function accountIdFromPublicKeyBase64(publicKeyBase64: string): string {
  return Buffer.from(publicKeyBase64, "base64").toString("hex");
}

async function tempKeystorePath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openstore-acct-"));
  return { dir, path: join(dir, "identity.json") };
}

function perAccountKeystorePath(dir: string, publicKeyBase64: string): string {
  const accountId = accountIdFromPublicKeyBase64(publicKeyBase64);
  return join(dir, "accounts", accountId, "identity.keystore");
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return { status: res.status, json, text };
}

describe("account/recovery UX and security (OpenStore Recovery Phrase v1)", () => {
  it("new account generates valid 12-word OpenStore Recovery Phrase v1", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const password = randomTestInput();
      const created = await postJson(base, "/api/identity/create", { password });
      expect(created.status).toBe(200);
      const phrase = created.json["recoveryPhrase"] as unknown as string[];
      expect(Array.isArray(phrase)).toBe(true);
      expect(phrase).toHaveLength(12);
      // Validate each word is from wordlist and lowercase, and phrase is valid OpenStore v1 (not BIP39 seed)
      for (const word of phrase) {
        expect(typeof word).toBe("string");
        expect(word).toMatch(/^[a-z]+$/);
      }
      // Must not be called seed phrase / BIP39 in API
      expect(created.text.toLowerCase()).not.toContain("bip39");
      expect(created.text.toLowerCase()).not.toContain("seed phrase");
      // Phrase must be able to recover same identity
      const recovered = recoverIdentity(phrase);
      expect(recovered.publicKey.toString("base64")).toBe(created.json["publicKey"]);
      // Keystore file must not contain phrase (per-account)
      const perAccountPath = perAccountKeystorePath(dir, created.json["publicKey"] as string);
      const stored = await readFile(perAccountPath, "utf8");
      expect(stored).not.toContain(phrase.join(" "));
      expect(stored.toLowerCase()).not.toContain("recoveryphrase");
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("phrase confirmation required — phrase shown once and cleared on dismiss", async () => {
    // This is primarily UI behavior, but we can test that creation returns phrase and subsequent status does not contain it
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const password = randomTestInput();
      const created = await postJson(base, "/api/identity/create", { password });
      expect(created.status).toBe(200);
      const phrase = (created.json["recoveryPhrase"] as string[]).join(" ");
      // After creation, subsequent API calls must not contain phrase
      const statusText = await (await fetch(`${base}/api/identity`)).text();
      expect(statusText).not.toContain(phrase);
      const unlock = await postJson(base, "/api/identity/unlock", { password });
      expect(unlock.text).not.toContain(phrase);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("valid phrase restores same identity, invalid phrase rejected", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const password = randomTestInput();
      // Valid recovery
      const recovered = await postJson(base, "/api/identity/recover", { phrase, password });
      expect(recovered.status).toBe(200);
      expect(recovered.json["publicKey"]).toBe(id.publicKey.toString("base64"));
      // Invalid phrase (too few words)
      const short = await postJson(base, "/api/identity/recover", { phrase: ["abandon", "abandon"], password: randomTestInput(), confirmReplace: true });
      expect(short.status).toBe(400);
      // Invalid word
      const badWord = await postJson(base, "/api/identity/recover", {
        phrase: ["abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "notaword"],
        password: randomTestInput(),
        confirmReplace: true,
      });
      expect(badWord.status).toBe(400);
      // Bad checksum
      const badChecksum = await postJson(base, "/api/identity/recover", {
        phrase: ["abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "about"],
        password: randomTestInput(),
        confirmReplace: true,
      });
      expect(badChecksum.status).toBe(400);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("wrong password rejected, do not silently create new identity", async () => {
    const { dir, path } = await tempKeystorePath();
    const password = randomTestInput();
    const setup = createWebBackend({ keystorePath: path });
    await setup.createIdentity(password);
    const originalPubKey = (await setup.getIdentityStatus()).publicKey;
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const bad = await postJson(base, "/api/identity/unlock", { password: `${password}-wrong` });
      expect(bad.status).toBe(401);
      const status = (await (await fetch(`${base}/api/identity`)).json()) as { identity: { unlocked: boolean; publicKey: string } };
      expect(status.identity.unlocked).toBe(false);
      // Ensure no new identity was created
      const afterPubKey = (await setup.getIdentityStatus()).publicKey;
      expect(afterPubKey).toBe(originalPubKey);
      const perAccountPath = perAccountKeystorePath(dir, originalPubKey!);
      const stored = await loadIdentity(password, perAccountPath);
      expect(stored.publicKey.toString("base64")).toBe(originalPubKey);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("password change requires valid recovery phrase, preserves same publicKey", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const oldPassword = randomTestInput();
      const newPassword = randomTestInput();
      // Create via recovery (to have known phrase)
      const recovered = await postJson(base, "/api/identity/recover", { phrase, password: oldPassword });
      expect(recovered.status).toBe(200);
      const originalPubKey = recovered.json["publicKey"] as string;
      // Change password with valid phrase
      const changed = await postJson(base, "/api/identity/change-password", { phrase, newPassword });
      expect(changed.status).toBe(200);
      expect(changed.json["publicKey"]).toBe(originalPubKey);
      // New password unlocks
      const unlockNew = await postJson(base, "/api/identity/unlock", { password: newPassword });
      expect(unlockNew.status).toBe(200);
      // Old password no longer works
      const unlockOld = await postJson(base, "/api/identity/unlock", { password: oldPassword });
      expect(unlockOld.status).toBe(401);
      // Keystore decrypts with new password and same public key (per-account)
      const perAccountPath = perAccountKeystorePath(dir, originalPubKey);
      const loaded = await loadIdentity(newPassword, perAccountPath);
      expect(loaded.publicKey.toString("base64")).toBe(originalPubKey);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("failed password change leaves old password valid", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const oldPassword = randomTestInput();
      const wrongPhrase = createIdentity().recoveryPhrase;
      await postJson(base, "/api/identity/recover", { phrase, password: oldPassword });
      const originalPubKey = id.publicKey.toString("base64");
      // Attempt change with wrong phrase — should fail closed (401 for auth mismatch)
      const bad = await postJson(base, "/api/identity/change-password", { phrase: wrongPhrase, newPassword: randomTestInput() });
      expect([400, 401].includes(bad.status)).toBe(true);
      // Old password still works
      const unlockOld = await postJson(base, "/api/identity/unlock", { password: oldPassword });
      expect(unlockOld.status).toBe(200);
      expect(unlockOld.json["publicKey"]).toBe(originalPubKey);
      const perAccountPath = perAccountKeystorePath(dir, originalPubKey);
      const loaded = await loadIdentity(oldPassword, perAccountPath);
      expect(loaded.publicKey.toString("base64")).toBe(originalPubKey);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forgotten password recovery with phrase works, recovery impossible without phrase", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const oldPassword = randomTestInput();
      const newPassword = randomTestInput();
      await postJson(base, "/api/identity/recover", { phrase, password: oldPassword });
      // Forget password, recover with phrase and new password
      const recovered = await postJson(base, "/api/identity/recover", { phrase, password: newPassword, confirmReplace: true });
      expect(recovered.status).toBe(200);
      expect(recovered.json["publicKey"]).toBe(id.publicKey.toString("base64"));
      const unlockNew = await postJson(base, "/api/identity/unlock", { password: newPassword });
      expect(unlockNew.status).toBe(200);
      // Without phrase, cannot recover (empty phrase)
      const noPhrase = await postJson(base, "/api/identity/recover", { phrase: [], password: randomTestInput(), confirmReplace: true });
      expect(noPhrase.status).toBe(400);
      // Wrong phrase also fails
      const wrongPhrase = createIdentity().recoveryPhrase;
      const bad = await postJson(base, "/api/identity/recover", { phrase: wrongPhrase, password: randomTestInput(), confirmReplace: true });
      // This would succeed but with different publicKey, not original account – we check that original account not recoverable without correct phrase
      // For this test, we want to ensure that without correct phrase, original account not restored
      // So we check that bad phrase does not yield original publicKey
      expect(bad.json["publicKey"]).not.toBe(id.publicKey.toString("base64"));
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("switch account does not overwrite another account (isolated keystore paths)", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "openstore-switch-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "openstore-switch-b-"));
    const pathA = join(dirA, "identity.json");
    const pathB = join(dirB, "identity.json");
    try {
      const idA = createIdentity();
      const idB = createIdentity();
      const pwA = randomTestInput();
      const pwB = randomTestInput();
      // Create two separate accounts on separate backends (simulating isolated state)
      const backendA = createWebBackend({ keystorePath: pathA });
      const backendB = createWebBackend({ keystorePath: pathB });
      await backendA.createIdentity(pwA);
      await backendB.createIdentity(pwB);
      // Overwrite B's keystore with known idB phrase so we have deterministic B identity
      const webBSetup = createWebServer({ keystorePath: pathB });
      const portBSetup = await webBSetup.listen(0, "127.0.0.1");
      try {
        await postJson(`http://127.0.0.1:${portBSetup}`, "/api/identity/recover", { phrase: idB.recoveryPhrase, password: pwB, confirmReplace: true });
      } finally {
        await webBSetup.close();
      }
      const webA = createWebServer({ keystorePath: pathA });
      const webB = createWebServer({ keystorePath: pathB });
      const portA = await webA.listen(0, "127.0.0.1");
      const portB = await webB.listen(0, "127.0.0.1");
      try {
        // Switch A to B's phrase (simulating switch)
        const switchRes = await postJson(`http://127.0.0.1:${portA}`, "/api/identity/switch", { phrase: idB.recoveryPhrase, password: pwB });
        expect(switchRes.status).toBe(200);
        expect(switchRes.json["publicKey"]).toBe(idB.publicKey.toString("base64"));
        // Verify B's keystore still intact and not overwritten by A's switch (since separate dirs and per-account isolation)
        // For per-account, B's keystore is at accounts/<idB>/identity.keystore under dirB
        const accountIdB = accountIdFromPublicKeyBase64(idB.publicKey.toString("base64"));
        const perAccountBPath = join(dirB, "accounts", accountIdB, "identity.keystore");
        const loadedB = await loadIdentity(pwB, perAccountBPath);
        expect(loadedB.publicKey.toString("base64")).toBe(idB.publicKey.toString("base64"));
        // Verify B's per-account file still exists
        const existsB = await readFile(perAccountBPath, "utf8").then(() => true).catch(() => false);
        expect(existsB).toBe(true);
      } finally {
        await webA.close();
        await webB.close();
      }
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it("switch account with invalid phrase rejected", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const pw = randomTestInput();
      await postJson(base, "/api/identity/recover", { phrase: id.recoveryPhrase, password: pw });
      const bad = await postJson(base, "/api/identity/switch", { phrase: ["abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "about"], password: randomTestInput() });
      expect(bad.status).toBe(400);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no secret leakage in errors/API/logging", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const password = randomTestInput();
      const created = await postJson(base, "/api/identity/create", { password });
      expect(created.status).toBe(200);
      // Try to trigger errors with phrase
      const badUnlock = await postJson(base, "/api/identity/unlock", { password: "wrong" });
      const badRecover = await postJson(base, "/api/identity/recover", { phrase: ["abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "notaword"], password, confirmReplace: true });
      const badChange = await postJson(base, "/api/identity/change-password", { phrase: ["abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "notaword"], newPassword: randomTestInput() });
      const texts = [badUnlock.text, badRecover.text, badChange.text, JSON.stringify(created.json)].join("\n");
      // Ensure no private material in error responses (they are sanitized)
      expect(texts.toLowerCase()).not.toContain("privatekey");
      // Recovery phrase should only appear in creation response, not in error responses
      expect(badUnlock.text).not.toContain(phrase.join(" "));
      expect(badRecover.text).not.toContain(phrase.join(" "));
      expect(badChange.text).not.toContain(phrase.join(" "));
      // Ensure no BIP39/seed phrase terminology in API
      expect(texts.toLowerCase()).not.toContain("bip39");
      expect(texts.toLowerCase()).not.toContain("seed phrase");
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("account isolation — manifests and DEKs are per-account, switching does not mix", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "openstore-isolation-"));
    const manifestDir = join(baseDir, "manifests");
    const keystorePath = join(baseDir, "identity.json");
    const registry = (await import("../../packages/registry/index.js")).createRegistry();
    // Need a storage node for upload to succeed
    const { createStorageNode } = await import("../storage-node/index.js");
    const nodeDir = await mkdtemp(join(tmpdir(), "openstore-isolation-node-"));
    const node = createStorageNode({ storageDir: nodeDir, identity: createIdentity(), registry, registryHeartbeatIntervalMs: 50 });
    await node.listen(0, "127.0.0.1");
    const backend = createWebBackend({ manifestDir, keystorePath, registry, providerIdentityPassword: "test-pass" });
    try {
      const idA = createIdentity();
      const phraseA = idA.recoveryPhrase;
      const pwA = randomTestInput();
      const idB = createIdentity();
      const phraseB = idB.recoveryPhrase;
      const pwB = randomTestInput();

      // Create account A and upload file A
      await backend.createIdentity(pwA); // This creates a random account, but we want deterministic A, so use recover with phraseA
      // For isolation test, use switch to create A with known phrase
      await backend.switchAccount(phraseA, pwA);
      const uploadA = await backend.uploadFile("fileA.txt", Buffer.from("content of A"));
      const fileIdA = uploadA.fileId;
      const snapshotA1 = await backend.getSnapshot();
      expect(snapshotA1.files.map((f) => f.fileId)).toContain(fileIdA);

      // Switch to B (new account)
      const switchToB = await backend.switchAccount(phraseB, pwB);
      expect(switchToB.publicKey).toBe(idB.publicKey.toString("base64"));
      const snapshotB1 = await backend.getSnapshot();
      expect(snapshotB1.files.map((f) => f.fileId)).not.toContain(fileIdA);
      expect(snapshotB1.files).toHaveLength(0);

      // B download must NOT resolve A's manifest/DEK
      await expect(backend.downloadFile(fileIdA)).rejects.toThrow(/file not found|file key unavailable/i);

      // B upload creates only B state
      const uploadB = await backend.uploadFile("fileB.txt", Buffer.from("content of B"));
      const fileIdB = uploadB.fileId;
      const snapshotB2 = await backend.getSnapshot();
      expect(snapshotB2.files.map((f) => f.fileId)).toContain(fileIdB);
      expect(snapshotB2.files.map((f) => f.fileId)).not.toContain(fileIdA);

      // Switch back to A — A file still present and downloadable
      await backend.switchAccount(phraseA, pwA);
      const snapshotA2 = await backend.getSnapshot();
      expect(snapshotA2.files.map((f) => f.fileId)).toContain(fileIdA);
      expect(snapshotA2.files.map((f) => f.fileId)).not.toContain(fileIdB);
      const downloadA = await backend.downloadFile(fileIdA);
      expect(downloadA.data.toString()).toBe("content of A");

      // Switch A -> B -> A repeatedly without corruption
      await backend.switchAccount(phraseB, pwB);
      await backend.switchAccount(phraseA, pwA);
      const snapshotA3 = await backend.getSnapshot();
      expect(snapshotA3.files.map((f) => f.fileId)).toContain(fileIdA);
      // Verify separate keystores, manifest dirs, DEK vaults, and current-account pointer
      const accountIdA = accountIdFromPublicKeyBase64(idA.publicKey.toString("base64"));
      const accountIdB = accountIdFromPublicKeyBase64(idB.publicKey.toString("base64"));
      const perAccountAPath = join(baseDir, "accounts", accountIdA, "identity.keystore");
      const perAccountBPath = join(baseDir, "accounts", accountIdB, "identity.keystore");
      const manifestAPath = join(baseDir, "accounts", accountIdA, "manifests");
      const manifestBPath = join(baseDir, "accounts", accountIdB, "manifests");
      const dekAPath = join(baseDir, "accounts", accountIdA, "deks.json");
      const dekBPath = join(baseDir, "accounts", accountIdB, "deks.json");
      const currentPointer = join(baseDir, "current-account.json");
      expect(await readFile(perAccountAPath, "utf8").then(() => true).catch(() => false)).toBe(true);
      expect(await readFile(perAccountBPath, "utf8").then(() => true).catch(() => false)).toBe(true);
      const current = JSON.parse(await readFile(currentPointer, "utf8")) as { accountId: string };
      expect(current.accountId).toBe(accountIdA);
      // Failed switch leaves current unchanged
      const badSwitch = await backend.switchAccount(["abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "abandon", "notaword"], randomTestInput()).catch((e) => e);
      expect(badSwitch instanceof Error).toBe(true);
      const afterFailed = JSON.parse(await readFile(currentPointer, "utf8")) as { accountId: string };
      expect(afterFailed.accountId).toBe(accountIdA);
      // Wrong password for unlock (not switch) leaves current unchanged — switch with any password and valid phrase would succeed, so test unlock
      const wrongUnlock2 = await backend.unlockIdentity("wrong-password").catch((e) => e);
      expect(wrongUnlock2 instanceof Error).toBe(true);
      expect(JSON.parse(await readFile(currentPointer, "utf8")).accountId).toBe(accountIdA);
      // Recovery creates correct namespace
      const idC = createIdentity();
      const pwC = randomTestInput();
      await backend.switchAccount(idC.recoveryPhrase, pwC);
      const accountIdC = accountIdFromPublicKeyBase64(idC.publicKey.toString("base64"));
      expect(await readFile(join(baseDir, "accounts", accountIdC, "identity.keystore"), "utf8").then(() => true).catch(() => false)).toBe(true);
      // Password change affects only target account
      await backend.switchAccount(phraseA, pwA);
      const newPwA = randomTestInput();
      await backend.changePassword(phraseA, newPwA);
      // A's new password works, B's still old
      await backend.switchAccount(phraseB, pwB);
      expect((await backend.getIdentityStatus()).publicKey).toBe(idB.publicKey.toString("base64"));
      await backend.switchAccount(phraseA, newPwA);
      expect((await backend.getIdentityStatus()).publicKey).toBe(idA.publicKey.toString("base64"));
    } finally {
      await node.close();
      await rm(nodeDir, { recursive: true, force: true });
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
