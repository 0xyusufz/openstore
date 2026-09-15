import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createIdentity } from "../../packages/identity/index.js";
import { createAuthHeaders, SIGNATURE_HEADER } from "../../packages/auth/index.js";
import { hashPieceId } from "../../packages/manifest/index.js";
import { createStorageNode } from "./index.js";
import type { StorageNode } from "./index.js";
import { verifyPieceOnNode } from "../client/verify.js";

let storageDir = "";
let baseUrl = "";
let node: StorageNode;
const nodeIdentity = createIdentity();
const clientIdentity = createIdentity();

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function storeContentAddressed(bytes: Buffer): Promise<string> {
  const pieceId = hashPieceId(bytes);
  const res = await fetch(`${baseUrl}/pieces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: pieceId, data: bytes.toString("base64") }),
  });
  expect([200, 201]).toContain(res.status);
  return pieceId;
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "openstore-verify-"));
  node = createStorageNode({ storageDir, identity: nodeIdentity });
  const port = await node.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await node.close();
  await rm(storageDir, { recursive: true, force: true });
});

describe("storage piece integrity verification (OPENSTORE-017)", () => {
  it("1. valid stored piece verifies successfully", async () => {
    const bytes = Buffer.from("verify-me-integrity-001");
    const pieceId = await storeContentAddressed(bytes);
    const endpoint = { id: "verify-node", baseUrl };

    const result = await verifyPieceOnNode(endpoint, pieceId);
    expect(result.verified).toBe(true);
    expect(result.pieceId).toBe(pieceId);
    expect(result.size).toBe(bytes.length);
    expect(result.hash).toBe(sha256Hex(bytes));
    expect(result.error).toBeUndefined();
    // Node identity is authentic: reported public key matches node identity
    expect(result.publicKey).toBe(nodeIdentity.publicKey.toString("base64"));
    expect(result.nodeId).toBe(nodeIdentity.publicKey.toString("base64"));

    // Raw HTTP also returns metadata JSON
    const raw = await fetch(`${baseUrl}/pieces/${pieceId}/verify`);
    expect(raw.status).toBe(200);
    const json = (await raw.json()) as Record<string, unknown>;
    expect(json["verified"]).toBe(true);
    expect(json["hash"]).toBe(sha256Hex(bytes));
  });

  it("2. missing piece fails verification", async () => {
    const missingId = sha256Hex(Buffer.from("never-stored-bytes"));
    const raw = await fetch(`${baseUrl}/pieces/${missingId}/verify`);
    expect(raw.status).toBe(404);
    const json = (await raw.json()) as Record<string, unknown>;
    expect(json["verified"]).toBe(false);

    const result = await verifyPieceOnNode({ id: "verify-node", baseUrl }, missingId);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("3. corrupted stored piece fails verification", async () => {
    const bytes = Buffer.from("will-be-corrupted-003");
    const pieceId = await storeContentAddressed(bytes);
    // Corrupt the stored bytes directly on disk (bypasses POST validation)
    await writeFile(join(storageDir, pieceId), Buffer.from("tampered-corrupted-bytes"));

    const raw = await fetch(`${baseUrl}/pieces/${pieceId}/verify`);
    expect(raw.status).toBe(409);
    const json = (await raw.json()) as Record<string, unknown>;
    expect(json["verified"]).toBe(false);
    expect(json["hash"]).toBe(sha256Hex(Buffer.from("tampered-corrupted-bytes")));
    expect(json["hash"]).not.toBe(pieceId);

    const result = await verifyPieceOnNode({ id: "verify-node", baseUrl }, pieceId);
    expect(result.verified).toBe(false);
    expect(result.hash).not.toBe(pieceId);
  });

  it("4. wrong expected pieceId/hash fails", async () => {
    const bytes = Buffer.from("correct-piece-004");
    await storeContentAddressed(bytes);
    // A different (well-formed but wrong) expected hash
    const wrongId = sha256Hex(Buffer.from("something-else-entirely"));
    const result = await verifyPieceOnNode({ id: "verify-node", baseUrl }, wrongId);
    expect(result.verified).toBe(false);

    const raw = await fetch(`${baseUrl}/pieces/${wrongId}/verify`);
    expect(raw.status).toBe(404);
  });

  it("5. unauthenticated verification fails when auth is required", async () => {
    const authDir = await mkdtemp(join(tmpdir(), "openstore-verify-auth-"));
    const authNode = createStorageNode({ storageDir: authDir, requireAuth: true });
    const port = await authNode.listen(0, "127.0.0.1");
    const authBase = `http://127.0.0.1:${port}`;
    try {
      // Store a piece with signed request first
      const bytes = Buffer.from("auth-required-piece");
      const pieceId = hashPieceId(bytes);
      const body = JSON.stringify({ id: pieceId, data: bytes.toString("base64") });
      const headers = createAuthHeaders(clientIdentity, "POST", "/pieces", Buffer.from(body, "utf8"));
      const stored = await fetch(`${authBase}/pieces`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      expect([200, 201]).toContain(stored.status);

      // Unsigned verification must fail
      const unsigned = await fetch(`${authBase}/pieces/${pieceId}/verify`);
      expect(unsigned.status).toBe(401);

      // Client API without identity must throw (auth error, not a verification result)
      await expect(verifyPieceOnNode({ id: "auth-node", baseUrl: authBase }, pieceId)).rejects.toThrow(/401/);

      // Signed verification succeeds
      const signed = await verifyPieceOnNode({ id: "auth-node", baseUrl: authBase }, pieceId, { identity: clientIdentity });
      expect(signed.verified).toBe(true);
    } finally {
      await authNode.close();
      await rm(authDir, { recursive: true, force: true });
    }
  });

  it("6. tampered request fails", async () => {
    const bytes = Buffer.from("tamper-test-piece-006");
    const pieceId = await storeContentAddressed(bytes);
    const path = `/pieces/${pieceId}/verify`;
    const headers = createAuthHeaders(clientIdentity, "GET", path);
    // Tamper with the signature
    const sig = Buffer.from(headers[SIGNATURE_HEADER] as string, "base64");
    sig[0] ^= 0xff;
    const tampered = { ...headers, [SIGNATURE_HEADER]: sig.toString("base64") };
    const res = await fetch(`${baseUrl}${path}`, { headers: tampered });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid signature/i);

    // Signature for a different path must also fail
    const wrongPathHeaders = createAuthHeaders(clientIdentity, "GET", "/pieces/other-id/verify");
    const res2 = await fetch(`${baseUrl}${path}`, { headers: wrongPathHeaders });
    expect(res2.status).toBe(401);
  });

  it("7. verification response contains no private key or plaintext piece data", async () => {
    const plaintext = Buffer.from("super-secret-plaintext-007");
    const pieceId = await storeContentAddressed(plaintext);
    const raw = await fetch(`${baseUrl}/pieces/${pieceId}/verify`);
    expect(raw.status).toBe(200);
    const text = await raw.text();
    // No plaintext, no base64-encoded piece bytes, no keys
    expect(text).not.toContain("super-secret-plaintext-007");
    expect(text).not.toContain(plaintext.toString("base64"));
    expect(text).not.toContain(nodeIdentity.privateKey.toString("base64"));
    expect(text).not.toContain(nodeIdentity.privateKey.toString("hex"));
    expect(text.toLowerCase()).not.toContain("privatekey");
    expect(text.toLowerCase()).not.toContain("encryptionkey");
    expect(text.toLowerCase()).not.toContain("recoveryphrase");
    // Only whitelisted metadata fields
    const json = JSON.parse(text) as Record<string, unknown>;
    const allowed = new Set(["version", "pieceId", "size", "hash", "verified", "nodeId", "publicKey"]);
    for (const key of Object.keys(json)) {
      expect(allowed.has(key)).toBe(true);
    }
    expect(json["verified"]).toBe(true);
  });
});
