import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createIdentity } from "../../packages/identity/index.js";
import { createWebServer } from "./server.js";

function randomTestInput(): string {
  return "test-" + randomBytes(12).toString("hex");
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch {}
  return { status: res.status, json };
}

async function getJson(base: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path);
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch {}
  return { status: res.status, json };
}

describe("auth enforcement and login flow", () => {
  it("/api/accounts returns account list (public, no auth)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const list = await getJson(base, "/api/accounts");
      expect(list.status).toBe(200);
      expect(Array.isArray(list.json["accounts"])).toBe(true);
      expect((list.json["accounts"] as unknown[])).toHaveLength(0);

      const pw = randomTestInput();
      await postJson(base, "/api/identity/create", { password: pw });

      const list2 = await getJson(base, "/api/accounts");
      expect(list2.status).toBe(200);
      const accounts = list2.json["accounts"] as Array<{ accountId: string; publicKey: string }>;
      expect(accounts).toHaveLength(1);
      expect(accounts[0].accountId).toMatch(/^[0-9a-f]+$/);
      expect(accounts[0].publicKey).toBeTruthy();
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/api/accounts/login unlocks correct account, rejects wrong password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-login-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const pw = randomTestInput();
      const created = await postJson(base, "/api/identity/create", { password: pw });
      expect(created.status).toBe(200);

      const list = await getJson(base, "/api/accounts");
      const accounts = list.json["accounts"] as Array<{ accountId: string; publicKey: string }>;
      expect(accounts).toHaveLength(1);
      const acct = accounts[0];

      await postJson(base, "/api/identity/lock", {});

      const bad = await postJson(base, "/api/accounts/login", { accountId: acct.accountId, password: pw + "-wrong" });
      expect(bad.status).toBe(401);

      const good = await postJson(base, "/api/accounts/login", { accountId: acct.accountId, password: pw });
      expect(good.status).toBe(200);
      expect(good.json["publicKey"]).toBe(created.json["publicKey"]);
      expect(good.json["unlocked"]).toBe(true);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("protected API returns 401 when unauthenticated and accounts exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-protect-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const pw = randomTestInput();
      await postJson(base, "/api/identity/create", { password: pw });
      await postJson(base, "/api/identity/lock", {});

      const files = await getJson(base, "/api/files");
      expect(files.status).toBe(401);

      const nodes = await getJson(base, "/api/nodes");
      expect(nodes.status).toBe(401);

      // /api/identity is public (needed for login page)
      const identity = await getJson(base, "/api/identity");
      expect(identity.status).toBe(200);

      const provider = await getJson(base, "/api/provider");
      expect(provider.status).toBe(401);

      const accounts = await getJson(base, "/api/accounts");
      expect(accounts.status).toBe(200);

      const health = await getJson(base, "/api/health");
      expect(health.status).toBe(200);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("after login, protected API returns 200", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-after-login-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const pw = randomTestInput();
      await postJson(base, "/api/identity/create", { password: pw });
      await postJson(base, "/api/identity/lock", {});

      const blocked = await getJson(base, "/api/files");
      expect(blocked.status).toBe(401);

      const list = await getJson(base, "/api/accounts");
      const accounts = list.json["accounts"] as Array<{ accountId: string; publicKey: string }>;
      const login = await postJson(base, "/api/accounts/login", { accountId: accounts[0].accountId, password: pw });
      expect(login.status).toBe(200);

      const files = await getJson(base, "/api/files");
      expect(files.status).toBe(200);

      const nodes = await getJson(base, "/api/nodes");
      expect(nodes.status).toBe(200);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("after logout, protected API returns 401 again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-logout-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const pw = randomTestInput();
      await postJson(base, "/api/identity/create", { password: pw });

      const files1 = await getJson(base, "/api/files");
      expect(files1.status).toBe(200);

      const lock = await postJson(base, "/api/identity/lock", {});
      expect(lock.status).toBe(200);

      const files2 = await getJson(base, "/api/files");
      expect(files2.status).toBe(401);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no accounts configured allows public access to protected routes (first-run)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-first-run-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const files = await getJson(base, "/api/files");
      expect(files.status).toBe(200);

      const nodes = await getJson(base, "/api/nodes");
      expect(nodes.status).toBe(200);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("GET / serves the frontend shell even when auth is required and locked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-shell-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const pw = randomTestInput();
      await postJson(base, "/api/identity/create", { password: pw });
      await postJson(base, "/api/identity/lock", {});

      // Frontend shell must be served regardless of auth state
      const shell = await fetch(base + "/");
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-type")).toContain("text/html");
      const text = await shell.text();
      expect(text).toContain("OpenStore");
      expect(text).toContain('<script type="module"');

      // Static assets must not be blocked
      const css = await fetch(base + "/styles.css");
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");

      const js = await fetch(base + "/src/app.js");
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("text/javascript");

      // SPA fallback for extensionless routes must also work
      const spa = await fetch(base + "/dashboard");
      expect(spa.status).toBe(200);
      expect(spa.headers.get("content-type")).toContain("text/html");
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("login/account APIs remain usable while logged out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-login-usable-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const pw = randomTestInput();
      await postJson(base, "/api/identity/create", { password: pw });
      await postJson(base, "/api/identity/lock", {});

      // Account listing works while locked
      const accounts = await getJson(base, "/api/accounts");
      expect(accounts.status).toBe(200);
      expect(Array.isArray(accounts.json["accounts"])).toBe(true);

      // Identity status is public (needed for login page)
      const identity = await getJson(base, "/api/identity");
      expect(identity.status).toBe(200);

      // Login works while locked
      const acctList = accounts.json["accounts"] as Array<{ accountId: string }>;
      const login = await postJson(base, "/api/accounts/login", { accountId: acctList[0].accountId, password: pw });
      expect(login.status).toBe(200);

      // After login, protected APIs work
      const files = await getJson(base, "/api/files");
      expect(files.status).toBe(200);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("account isolation A -> logout -> B -> logout -> A preserves identity isolation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-auth-iso-"));
    const path = join(dir, "identity.json");
    const web = createWebServer({ keystorePath: path });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = "http://127.0.0.1:" + port;
      const idA = createIdentity();
      const idB = createIdentity();
      const pwA = randomTestInput();
      const pwB = randomTestInput();

      // Create A via recover
      await postJson(base, "/api/identity/recover", { phrase: idA.recoveryPhrase, password: pwA, confirmReplace: false });

      // Login as A
      const list1 = await getJson(base, "/api/accounts");
      const accounts1 = list1.json["accounts"] as Array<{ accountId: string; publicKey: string }>;
      expect(accounts1).toHaveLength(1);
      const acctAId = accounts1[0].accountId;
      await postJson(base, "/api/accounts/login", { accountId: acctAId, password: pwA });

      // A sees its own identity
      const idRes1 = await getJson(base, "/api/identity");
      expect(idRes1.status).toBe(200);

      // Logout A
      await postJson(base, "/api/identity/lock", {});

      // Create B via recover
      await postJson(base, "/api/identity/recover", { phrase: idB.recoveryPhrase, password: pwB, confirmReplace: true });

      // Login as B
      const list2 = await getJson(base, "/api/accounts");
      const accounts2 = list2.json["accounts"] as Array<{ accountId: string; publicKey: string }>;
      expect(accounts2.length).toBeGreaterThanOrEqual(1);
      const acctB = accounts2.find((a) => {
        const expected = Buffer.from(idB.publicKey).toString("hex");
        return a.accountId === expected;
      }) ?? accounts2[accounts2.length - 1];
      await postJson(base, "/api/accounts/login", { accountId: acctB.accountId, password: pwB });

      // B sees its own identity, not A's
      const idRes2 = await getJson(base, "/api/identity");
      expect(idRes2.status).toBe(200);
      const bIdentity = idRes2.json["identity"] as { publicKey?: string };
      expect(bIdentity.publicKey).toBe(idB.publicKey.toString("base64"));

      // Logout B, login A
      await postJson(base, "/api/identity/lock", {});
      await postJson(base, "/api/accounts/login", { accountId: acctAId, password: pwA });

      // A sees its own identity again
      const idRes3 = await getJson(base, "/api/identity");
      expect(idRes3.status).toBe(200);
      const aIdentity = idRes3.json["identity"] as { publicKey?: string };
      expect(aIdentity.publicKey).toBe(idA.publicKey.toString("base64"));

      // Verify separate accounts exist on disk
      const accounts3 = (await getJson(base, "/api/accounts")).json["accounts"] as Array<{ accountId: string; publicKey: string }>;
      expect(accounts3.length).toBeGreaterThanOrEqual(2);
    } finally {
      await web.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
