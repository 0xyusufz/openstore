import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createIdentity } from "../../packages/identity/index.js";
import { loadIdentity } from "../../packages/identity/keystore.js";
import { createWebBackend } from "./backend.js";
import { createWebServer } from "./server.js";

function randomTestInput(): string {
  return `test-${randomBytes(12).toString("hex")}`;
}

async function tempKeystorePath(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "openstore-web-id-"));
  return { dir, path: join(dir, "identity.json") };
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

describe("frontend identity & local unlock (OPENSTORE-025)", () => {
  it("1. first-run identity flow", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const password = randomTestInput();

      // No keystore yet: status unconfigured
      const before = (await (await fetch(`${base}/api/identity`)).json()) as { identity: { configured: boolean } };
      expect(before.identity.configured).toBe(false);

      // Create works once
      const created = await postJson(base, "/api/identity/create", { password });
      expect(created.status).toBe(200);
      expect(typeof created.json["publicKey"]).toBe("string");
      expect(Array.isArray(created.json["recoveryPhrase"])).toBe(true);
      expect((created.json["recoveryPhrase"] as unknown[])).toHaveLength(12);

      // Keystore file decrypts with the same password
      const loaded = await loadIdentity(password, path);
      expect(loaded.publicKey.toString("base64")).toBe(created.json["publicKey"]);

      // Status now configured + unlocked
      const after = (await (await fetch(`${base}/api/identity`)).json()) as {
        identity: { configured: boolean; unlocked: boolean; publicKey: string };
      };
      expect(after.identity.configured).toBe(true);
      expect(after.identity.unlocked).toBe(true);
      expect(after.identity.publicKey).toBe(created.json["publicKey"]);

      // Second creation refused without touching the existing keystore
      const again = await postJson(base, "/api/identity/create", { password: randomTestInput() });
      expect(again.status).toBe(409);
      expect(await loadIdentity(password, path)).toBeDefined();
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. keystore unlock success (and lock)", async () => {
    const { dir, path } = await tempKeystorePath();
    const password = randomTestInput();
    const setup = createWebBackend({ keystorePath: path });
    const created = await setup.createIdentity(password);
    // Fresh backend instance: unlocked flag reset (simulates restart)
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const locked = (await (await fetch(`${base}/api/identity`)).json()) as { identity: { unlocked: boolean } };
      expect(locked.identity.unlocked).toBe(false);

      const unlocked = await postJson(base, "/api/identity/unlock", { password });
      expect(unlocked.status).toBe(200);
      expect(unlocked.json["unlocked"]).toBe(true);
      expect(unlocked.json["publicKey"]).toBe(created.publicKey);

      const status = (await (await fetch(`${base}/api/identity`)).json()) as { identity: { unlocked: boolean } };
      expect(status.identity.unlocked).toBe(true);

      const lock = await postJson(base, "/api/identity/lock", {});
      expect(lock.status).toBe(200);
      expect(lock.json["locked"]).toBe(true);
      const relocked = (await (await fetch(`${base}/api/identity`)).json()) as { identity: { unlocked: boolean } };
      expect(relocked.identity.unlocked).toBe(false);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("3. wrong password failure", async () => {
    const { dir, path } = await tempKeystorePath();
    const password = randomTestInput();
    const setup = createWebBackend({ keystorePath: path });
    await setup.createIdentity(password);
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const bad = await postJson(base, "/api/identity/unlock", { password: `${password}-wrong` });
      expect(bad.status).toBe(401);
      expect(typeof bad.json["error"]).toBe("string");
      const status = (await (await fetch(`${base}/api/identity`)).json()) as { identity: { unlocked: boolean } };
      expect(status.identity.unlocked).toBe(false);

      // Empty password rejected as bad input, not auth
      const empty = await postJson(base, "/api/identity/unlock", { password: "" });
      expect(empty.status).toBe(400);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("4. malformed/missing keystore handling", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      // Missing file
      const missing = await postJson(base, "/api/identity/unlock", { password: randomTestInput() });
      expect(missing.status).toBe(404);

      // Malformed file
      await writeFile(path, "not json {{{", { mode: 0o600 });
      const malformed = await postJson(base, "/api/identity/unlock", { password: randomTestInput() });
      expect(malformed.status).toBe(400);
      const status = (await (await fetch(`${base}/api/identity`)).json()) as {
        identity: { configured: boolean; unlocked: boolean; label: string };
      };
      expect(status.identity.configured).toBe(false);
      expect(status.identity.unlocked).toBe(false);
      expect(status.identity.label).toMatch(/malformed/i);

      // Creation refused while a (broken) keystore file exists
      const create = await postJson(base, "/api/identity/create", { password: randomTestInput() });
      expect(create.status).toBe(409);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("5. recovery phrase shown only during creation and never persisted", async () => {
    const { dir, path } = await tempKeystorePath();
    const password = randomTestInput();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const created = await postJson(base, "/api/identity/create", { password });
      expect(created.status).toBe(200);
      const phrase = created.json["recoveryPhrase"] as string[];
      expect(phrase).toHaveLength(12);

      // Keystore file never contains the phrase
      const stored = await readFile(path, "utf8");
      expect(stored).not.toContain(phrase.join(" "));
      expect(stored.toLowerCase()).not.toContain("recoveryphrase");
      expect(stored.toLowerCase()).not.toContain("mnemonic");

      // Later reads never resurface the phrase
      const statusText = await (await fetch(`${base}/api/identity`)).text();
      expect(statusText).not.toContain(phrase.join(" "));
      const unlock = await postJson(base, "/api/identity/lock", {});
      expect(unlock.text).not.toContain(phrase.join(" "));
      const relock = await postJson(base, "/api/identity/unlock", { password });
      expect(Object.keys(relock.json).sort()).toEqual(["publicKey", "unlocked"]);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("6. browser/API outputs contain no private material", async () => {
    const { dir, path } = await tempKeystorePath();
    const password = randomTestInput();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const created = await postJson(base, "/api/identity/create", { password });
      expect(created.status).toBe(200);
      // Creation response: exactly publicKey + recoveryPhrase
      expect(Object.keys(created.json).sort()).toEqual(["publicKey", "recoveryPhrase"]);

      const seen: string[] = [];
      const collect = async (path: string, init?: RequestInit): Promise<void> => {
        const res = await fetch(`${base}${path}`, init);
        expect(res.headers.get("set-cookie")).toBeNull();
        seen.push(await res.text());
      };
      await collect("/api/identity");
      await collect("/api/files");
      await collect("/api/nodes");
      await collect("/health");
      await collect("/api/identity/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: `${password}-wrong` }),
      });
      const text = seen.join("\n");
      expect(text).not.toContain(password);
      expect(text.toLowerCase()).not.toContain("privatekey");
      expect(text.toLowerCase()).not.toContain("encryptionkey");
      // The creation phrase appears only in the creation response, nowhere else
      const phrase = (created.json["recoveryPhrase"] as string[]).join(" ");
      expect(text).not.toContain(phrase);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("7. demo mode remains functional", async () => {
    const backend = createWebBackend();
    expect(backend.status.demoMode).toBe(true);
    const status = await backend.getIdentityStatus();
    expect(status.configured).toBe(false);

    const web = createWebServer();
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const create = await postJson(base, "/api/identity/create", { password: randomTestInput() });
      expect(create.status).toBe(400);
      const unlock = await postJson(base, "/api/identity/unlock", { password: randomTestInput() });
      expect(unlock.status).toBe(400);
      const identity = (await (await fetch(`${base}/api/identity`)).json()) as {
        identity: { configured: boolean; unlocked: boolean };
      };
      expect(identity.identity.configured).toBe(false);
      expect(identity.identity.unlocked).toBe(false);
      // Lock is harmless without management
      const lock = await postJson(base, "/api/identity/lock", {});
      expect(lock.status).toBe(200);
    } finally {
      await web.close();
    }
  });

  it("8. recovery from phrase restores identity", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const password = randomTestInput();

      // No keystore: recovery succeeds
      const recovered = await postJson(base, "/api/identity/recover", { phrase, password });
      expect(recovered.status).toBe(200);
      expect(typeof recovered.json["publicKey"]).toBe("string");

      // Keystore decrypts with the new password
      const loaded = await loadIdentity(password, path);
      expect(loaded.publicKey.toString("base64")).toBe(recovered.json["publicKey"]);

      // Public key matches the deterministic derivation from the phrase
      expect(recovered.json["publicKey"]).toBe(id.publicKey.toString("base64"));

      // Identity is now configured + unlocked
      const status = (await (await fetch(`${base}/api/identity`)).json()) as {
        identity: { configured: boolean; unlocked: boolean; publicKey: string };
      };
      expect(status.identity.configured).toBe(true);
      expect(status.identity.unlocked).toBe(true);
      expect(status.identity.publicKey).toBe(recovered.json["publicKey"]);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("9. recovery with invalid phrase is rejected", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const password = randomTestInput();

      // Too few words
      const short = await postJson(base, "/api/identity/recover", {
        phrase: ["abandon", "abandon", "abandon"],
        password,
      });
      expect(short.status).toBe(400);
      expect(typeof short.json["error"]).toBe("string");

      // Invalid word
      const badWord = await postJson(base, "/api/identity/recover", {
        phrase: [
          "abandon", "abandon", "abandon", "abandon",
          "abandon", "abandon", "abandon", "abandon",
          "abandon", "abandon", "abandon", "notaword",
        ],
        password,
      });
      expect(badWord.status).toBe(400);

      // Bad checksum
      const badChecksum = await postJson(base, "/api/identity/recover", {
        phrase: [
          "abandon", "abandon", "abandon", "abandon",
          "abandon", "abandon", "abandon", "abandon",
          "abandon", "abandon", "abandon", "about",
        ],
        password,
      });
      expect(badChecksum.status).toBe(400);

      // No keystore created
      const status = (await (await fetch(`${base}/api/identity`)).json()) as {
        identity: { configured: boolean };
      };
      expect(status.identity.configured).toBe(false);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("10. recovery requires confirmReplace when keystore exists", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const setup = createWebBackend({ keystorePath: path });
      await setup.createIdentity(randomTestInput());

      const id2 = createIdentity();
      const password = randomTestInput();

      // Without confirmReplace: 409
      const denied = await postJson(base, "/api/identity/recover", {
        phrase: id2.recoveryPhrase,
        password,
      });
      expect(denied.status).toBe(409);
      expect(typeof denied.json["error"]).toBe("string");

      // With confirmReplace: 200
      const accepted = await postJson(base, "/api/identity/recover", {
        phrase: id2.recoveryPhrase,
        password,
        confirmReplace: true,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.json["publicKey"]).toBe(id2.publicKey.toString("base64"));

      // New keystore decrypts with the new password
      const loaded = await loadIdentity(password, path);
      expect(loaded.publicKey.toString("base64")).toBe(id2.publicKey.toString("base64"));
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("11. recovery phrase and password never leak in responses", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const password = randomTestInput();

      const recovered = await postJson(base, "/api/identity/recover", { phrase, password });
      expect(recovered.status).toBe(200);
      expect(recovered.text).not.toContain(password);
      expect(recovered.text).not.toContain(phrase.join(" "));

      // Check all endpoints for leakage
      const seen: string[] = [recovered.text];
      const collect = async (urlPath: string, init?: RequestInit): Promise<void> => {
        const res = await fetch(`${base}${urlPath}`, init);
        seen.push(await res.text());
      };
      await collect("/api/identity");
      await collect("/api/files");
      await collect("/api/nodes");
      await collect("/health");
      const allText = seen.join("\n");
      expect(allText).not.toContain(password);
      expect(allText).not.toContain(phrase.join(" "));
      expect(allText.toLowerCase()).not.toContain("privatekey");
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("12. recovery determinism: same phrase always yields same public key", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const pw1 = randomTestInput();
      const pw2 = randomTestInput();

      const r1 = await postJson(base, "/api/identity/recover", { phrase, password: pw1 });
      expect(r1.status).toBe(200);
      // Lock and recover again with a different password
      await postJson(base, "/api/identity/lock", {});
      const r2 = await postJson(base, "/api/identity/recover", {
        phrase,
        password: pw2,
        confirmReplace: true,
      });
      expect(r2.status).toBe(200);
      // Public key must be identical
      expect(r2.json["publicKey"]).toBe(r1.json["publicKey"]);
      expect(r2.json["publicKey"]).toBe(id.publicKey.toString("base64"));
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("13. demo mode recovery is rejected", async () => {
    const web = createWebServer();
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const recovered = await postJson(base, "/api/identity/recover", {
        phrase: id.recoveryPhrase,
        password: randomTestInput(),
      });
      expect(recovered.status).toBe(400);
    } finally {
      await web.close();
    }
  });

  it("14. create -> recover -> same public key", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const pw1 = randomTestInput();
      const created = await postJson(base, "/api/identity/create", { password: pw1 });
      expect(created.status).toBe(200);
      const phrase = created.json["recoveryPhrase"] as string[];
      const originalPubKey = created.json["publicKey"];

      // Lock and recover with new password
      await postJson(base, "/api/identity/lock", {});
      const pw2 = randomTestInput();
      const recovered = await postJson(base, "/api/identity/recover", {
        phrase,
        password: pw2,
        confirmReplace: true,
      });
      expect(recovered.status).toBe(200);
      expect(recovered.json["publicKey"]).toBe(originalPubKey);

      // New password unlocks
      const unlocked = await postJson(base, "/api/identity/unlock", { password: pw2 });
      expect(unlocked.status).toBe(200);
      expect(unlocked.json["publicKey"]).toBe(originalPubKey);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("15. forgot password -> recover with phrase -> new password unlocks", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const id = createIdentity();
      const phrase = id.recoveryPhrase;
      const oldPw = randomTestInput();
      const newPw = randomTestInput();

      // Create with old password, then "forget" it
      await postJson(base, "/api/identity/create", { password: oldPw });
      await postJson(base, "/api/identity/lock", {});

      // Recover with phrase + new password
      const recovered = await postJson(base, "/api/identity/recover", {
        phrase,
        password: newPw,
        confirmReplace: true,
      });
      expect(recovered.status).toBe(200);
      expect(recovered.json["publicKey"]).toBe(id.publicKey.toString("base64"));

      // Old password no longer works
      const oldPwAttempt = await postJson(base, "/api/identity/unlock", { password: oldPw });
      expect(oldPwAttempt.status).toBe(401);

      // New password works
      const newPwAttempt = await postJson(base, "/api/identity/unlock", { password: newPw });
      expect(newPwAttempt.status).toBe(200);
      expect(newPwAttempt.json["publicKey"]).toBe(id.publicKey.toString("base64"));
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("16. recovery phrase never persists in URL or storage after dismiss", async () => {
    const { dir, path } = await tempKeystorePath();
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const created = await postJson(base, "/api/identity/create", { password: randomTestInput() });
      const phrase = (created.json["recoveryPhrase"] as string[]).join(" ");

      // After any subsequent API call, phrase never appears
      await postJson(base, "/api/identity/lock", {});
      const afterLock = await (await fetch(`${base}/api/identity`)).text();
      expect(afterLock).not.toContain(phrase);

      const unlock = await postJson(base, "/api/identity/unlock", { password: randomTestInput() });
      expect(unlock.text).not.toContain(phrase);
      const afterUnlock = await (await fetch(`${base}/api/identity`)).text();
      expect(afterUnlock).not.toContain(phrase);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
