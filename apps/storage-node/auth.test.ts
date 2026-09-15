import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { createAuthHeaders, PUBKEY_HEADER, SIGNATURE_HEADER } from "../../packages/auth/index.js";
import { createStorageNode } from "./index.js";
import type { StorageNode } from "./index.js";

let storageDir = "";
let authDir = "";
let baseUrl = "";
let node: StorageNode;
let clientIdentity: ReturnType<typeof createIdentity>;
let nodeIdentity: ReturnType<typeof createIdentity>;
let nodeKeystorePath: string;
// Per-run generated test-only password (never hardcoded, never leaves the test).
let nodePassword = "";

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "openstore-auth-node-"));
  authDir = await mkdtemp(join(tmpdir(), "openstore-auth-key-"));
  clientIdentity = createIdentity();
  nodeIdentity = createIdentity();
  nodePassword = `test-node-pw-${randomBytes(12).toString("hex")}`;
  nodeKeystorePath = join(authDir, "node.json");
  await saveIdentity(nodeIdentity, nodePassword, nodeKeystorePath);

  node = createStorageNode({
    storageDir,
    identityPath: nodeKeystorePath,
    identityPassword: nodePassword,
    // Keep requireAuth false so test 8 (unsigned) still passes, but signed requests are validated if present
    requireAuth: false,
  });
  const port = await node.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await node.close();
  await rm(storageDir, { recursive: true, force: true });
  await rm(authDir, { recursive: true, force: true });
});

function signedHeaders(method: string, path: string, body?: Buffer, opts?: { timestamp?: number; nonce?: string }) {
  return createAuthHeaders(clientIdentity, method, path, body, opts);
}

async function getBytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

describe("storage node identity & authenticated requests (OPENSTORE-009)", () => {
  it("1. node identity can be created and persisted", async () => {
    expect(node.identity).toBeDefined();
    expect(node.identity?.publicKey.equals(nodeIdentity.publicKey)).toBe(true);
    expect(node.identity?.privateKey.equals(nodeIdentity.privateKey)).toBe(true);
    // Keystore file exists and doesn't contain private key plaintext
    const content = await readFile(nodeKeystorePath, "utf8");
    expect(content).not.toContain(nodeIdentity.privateKey.toString("base64"));
    // Private key not exposed via HTTP
    // No endpoint should return private key
    const res = await fetch(`${baseUrl}/pieces/nonexistent-009-1`);
    const text = await res.text();
    expect(text).not.toContain(nodeIdentity.privateKey.toString("base64"));
  });

  it("2. valid signed request succeeds", async () => {
    const body = JSON.stringify({ id: "auth-valid-001", data: Buffer.from("signed-payload").toString("base64") });
    const headers = {
      "content-type": "application/json",
      ...signedHeaders("POST", "/pieces", Buffer.from(body, "utf8")),
    };
    const res = await fetch(`${baseUrl}/pieces`, { method: "POST", headers, body });
    expect([200, 201]).toContain(res.status);

    const getHeaders = signedHeaders("GET", "/pieces/auth-valid-001");
    const got = await fetch(`${baseUrl}/pieces/auth-valid-001`, { headers: getHeaders });
    expect(got.status).toBe(200);
    expect((await getBytes(got)).toString()).toBe("signed-payload");
  });

  it("3. invalid signature fails", async () => {
    const body = JSON.stringify({ id: "auth-invalid-sig", data: Buffer.from("x").toString("base64") });
    const headers = signedHeaders("POST", "/pieces", Buffer.from(body, "utf8"));
    // Tamper signature
    const sig = Buffer.from(headers[SIGNATURE_HEADER] as string, "base64");
    sig[0] ^= 0xff;
    (headers as Record<string, string>)[SIGNATURE_HEADER] = sig.toString("base64");
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/invalid signature/i);
  });

  it("4. modified request payload fails", async () => {
    const originalBody = JSON.stringify({ id: "auth-tamper", data: Buffer.from("original").toString("base64") });
    const headers = signedHeaders("POST", "/pieces", Buffer.from(originalBody, "utf8"));
    const tamperedBody = JSON.stringify({ id: "auth-tamper", data: Buffer.from("tampered").toString("base64") });
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: tamperedBody,
    });
    expect(res.status).toBe(401);
  });

  it("5. expired timestamp fails", async () => {
    const body = JSON.stringify({ id: "auth-expired", data: Buffer.from("x").toString("base64") });
    const expiredTs = Date.now() - 10 * 60 * 1000; // 10 min ago, beyond 5 min skew
    const headers = signedHeaders("POST", "/pieces", Buffer.from(body, "utf8"), { timestamp: expiredTs });
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(res.status).toBe(401);
    const json = await res.json() as { error: string };
    expect(json.error).toMatch(/expired/i);
  });

  it("6. replayed request ID fails", async () => {
    const body = JSON.stringify({ id: "auth-replay", data: Buffer.from("once").toString("base64") });
    const nonce = randomBytes(16).toString("hex");
    const headers = signedHeaders("POST", "/pieces", Buffer.from(body, "utf8"), { nonce });
    const first = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect([200, 201]).toContain(first.status);

    // Replay same nonce/timestamp/signature
    const replayBody = JSON.stringify({ id: "auth-replay-2", data: Buffer.from("twice").toString("base64") });
    // Note: body changed but nonce same – however signature was for original body, so would fail anyway.
    // To test pure nonce replay, reuse exact same request
    const second = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    expect(second.status).toBe(401);
    const json = await second.json() as { error: string };
    expect(json.error).toMatch(/replayed/i);
  });

  it("7. private key is never included in HTTP request", async () => {
    const body = JSON.stringify({ id: "auth-priv-check", data: Buffer.from("check").toString("base64") });
    const headers = signedHeaders("POST", "/pieces", Buffer.from(body, "utf8"));
    const headerValues = Object.values(headers).join(" ");
    const privateB64 = clientIdentity.privateKey.toString("base64");
    const privateHex = clientIdentity.privateKey.toString("hex");
    expect(headerValues).not.toContain(privateB64);
    expect(headerValues).not.toContain(privateHex);
    expect(body).not.toContain(privateB64);
    // Also ensure node private key not in headers
    expect(headerValues).not.toContain(nodeIdentity.privateKey.toString("base64"));

    // Do a signed GET and verify private key not leaked in response
    const getHeaders = signedHeaders("GET", "/pieces/auth-valid-001");
    const res = await fetch(`${baseUrl}/pieces/auth-valid-001`, { headers: getHeaders });
    const resText = await res.text();
    // Response for GET is opaque bytes, not JSON, should not contain private key
    expect(resText).not.toContain(privateB64);
  });

  it("8. existing storage-node piece operations still work", async () => {
    // Unsigned requests should still succeed when requireAuth is false
    const bytes = Buffer.from("legacy-unsigned-piece");
    const postRes = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "legacy-plain", data: bytes.toString("base64") }),
    });
    expect([200, 201]).toContain(postRes.status);

    const getRes = await fetch(`${baseUrl}/pieces/legacy-plain`);
    expect(getRes.status).toBe(200);
    expect((await getBytes(getRes)).equals(bytes)).toBe(true);

    const headRes = await fetch(`${baseUrl}/pieces/legacy-plain`, { method: "HEAD" });
    expect(headRes.status).toBe(200);

    const delRes = await fetch(`${baseUrl}/pieces/legacy-plain`, { method: "DELETE" });
    expect(delRes.status).toBe(204);

    expect((await fetch(`${baseUrl}/pieces/legacy-plain`)).status).toBe(404);
  });
});
