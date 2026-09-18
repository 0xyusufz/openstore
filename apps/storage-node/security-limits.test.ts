import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createIdentity } from "../../packages/identity/index.js";
import { createAuthHeaders } from "../../packages/auth/index.js";
import { createStorageNode, type StorageNode } from "./index.js";

const dirs: string[] = [];
const nodes: StorageNode[] = [];

afterEach(async () => {
  for (const node of nodes.splice(0)) {
    try {
      await node.close();
    } catch {}
  }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function start(options: Record<string, unknown> = {}): Promise<{ port: number }> {
  const dir = await mkdtemp(join(tmpdir(), "openstore-066-sec-"));
  dirs.push(dir);
  const node = createStorageNode({ storageDir: dir, ...(options as object) });
  nodes.push(node);
  return { port: await node.listen(0, "127.0.0.1") };
}

function post(port: number, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/pieces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * Milestone 066: storage-node input/abuse boundaries.
 * - Piece IDs are charset-restricted (no traversal, no escape).
 * - Encryption-key fields are rejected.
 * - Oversized pieces are rejected when maxPieceBytes is configured (both
 *   plain and provenance paths), fail-closed without storing anything.
 * - Authenticated endpoints reject forged/replayed/missing signatures.
 * - Errors never echo key material, paths, or piece bytes.
 */
describe("Milestone 066: storage-node input and abuse boundaries", () => {
  it("rejects traversal, escape, and malformed piece IDs without touching disk", async () => {
    const { port } = await start();
    for (const bad of ["../evil", "..", "a/b", ".", "", "x".repeat(129), "sp ace", "semi;colon"]) {
      const res = await post(port, { id: bad, data: Buffer.from("x").toString("base64") });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid piece id" });
    }
    for (const bad of ["../evil", "%2e%2e", "%252e", "..%2f"]) {
      const res = await fetch(`http://127.0.0.1:${port}/pieces/${bad}`);
      expect([400, 404]).toContain(res.status);
    }
  });

  it("never accepts encryption keys and never echoes them back", async () => {
    const { port } = await start();
    const secret = `sk-${randomBytes(8).toString("hex")}`;
    for (const body of [{ id: "p1", data: "eA==", key: secret }, { id: "p2", data: "eA==", encryptionKey: secret }]) {
      const res = await post(port, body);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(secret);
      expect(text).toContain("never accepts encryption keys");
    }
  });

  it("enforces maxPieceBytes on the plain store path with 413", async () => {
    const { port } = await start({ maxPieceBytes: 16, capacityBytes: 1_000_000 });
    const big = await post(port, { id: "big1", data: Buffer.alloc(64).toString("base64") });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "piece too large" });
    // Nothing stored: fail-closed.
    expect((await fetch(`http://127.0.0.1:${port}/pieces/big1`)).status).toBe(404);
    const ok = await post(port, { id: "small1", data: Buffer.alloc(8).toString("base64") });
    expect(ok.status).toBe(201);
  });

  it("rejects invalid maxPieceBytes configuration explicitly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-066-sec-"));
    dirs.push(dir);
    for (const bad of [0, -1, 1.5, Number.NaN, "1024" as unknown as number]) {
      expect(() => createStorageNode({ storageDir: dir, maxPieceBytes: bad })).toThrow(/maxPieceBytes/);
    }
  });

  it("requires valid signatures when requireAuth is set, rejecting forgeries and replays", async () => {
    const identity = createIdentity();
    const { port } = await start({ requireAuth: true });
    const body = { id: "auth1", data: Buffer.from("hello").toString("base64") };
    const raw = Buffer.from(JSON.stringify(body));
    // Missing auth.
    expect((await post(port, body)).status).toBe(401);
    // Forged signature bytes ( Wrested from a valid signature so verification fails).
    const forged = createAuthHeaders(identity, "POST", "/pieces", raw);
    const badSig = Buffer.from(forged["x-openstore-signature"], "base64");
    badSig[0] = badSig[0]! ^ 0xff;
    forged["x-openstore-signature"] = badSig.toString("base64");
    expect((await post(port, body, forged as unknown as Record<string, string>)).status).toBe(401);
    // Valid signature succeeds.
    const valid = createAuthHeaders(identity, "POST", "/pieces", raw);
    expect((await post(port, body, valid as unknown as Record<string, string>)).status).toBe(201);
    // Exact replay of the same signed request is rejected.
    expect((await post(port, body, valid as unknown as Record<string, string>)).status).toBe(401);
    // Tampered body invalidates the signature.
    const tampered = { id: "auth1", data: Buffer.from("tampered-bytes!!").toString("base64") };
    expect((await post(port, tampered, valid as unknown as Record<string, string>)).status).toBe(401);
  });

  it("redacts secrets from error responses on unknown routes", async () => {
    const { port } = await start({ requireAuth: true });
    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      headers: { "x-openstore-pubkey": "bogus", "x-openstore-timestamp": "bogus", "x-openstore-nonce": "bogus", "x-openstore-signature": "bogus" },
    });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/bogus|private|trace|at .*:\d+/i);
  });
});
