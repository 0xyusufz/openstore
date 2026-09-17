import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createStorageNode } from "./index.js";
import type { StorageNode } from "./index.js";

let baseUrl = "";
let storageDir = "";
let node: StorageNode;

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "openstore-node-"));
  node = createStorageNode({ storageDir });
  const port = await node.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await node.close();
  await rm(storageDir, { recursive: true, force: true });
});

function postPiece(id: string, bytes: Buffer): Promise<Response> {
  return fetch(`${baseUrl}/pieces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, data: bytes.toString("base64") }),
  });
}

async function getBytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

describe("storage node MVP (OPENSTORE-003)", () => {
  it("1. stores and retrieves a piece", async () => {
    const bytes = Buffer.from("opaque-encrypted-piece-001");
    const posted = await postPiece("piece-alpha", bytes);
    expect([200, 201]).toContain(posted.status);

    const got = await fetch(`${baseUrl}/pieces/piece-alpha`);
    expect(got.status).toBe(200);
    expect((await getBytes(got)).equals(bytes)).toBe(true);
  });

  it("2. returns 404 for a missing piece", async () => {
    const got = await fetch(`${baseUrl}/pieces/does-not-exist-001`);
    expect(got.status).toBe(404);
  });

  it("3. HEAD reports existence without a body", async () => {
    await postPiece("piece-head", Buffer.from("head-check"));

    const existing = await fetch(`${baseUrl}/pieces/piece-head`, {
      method: "HEAD",
    });
    expect(existing.status).toBe(200);
    expect(existing.headers.get("content-length")).toBe(
      String(Buffer.from("head-check").length),
    );
    expect((await getBytes(existing)).length).toBe(0);

    const missing = await fetch(`${baseUrl}/pieces/head-missing-001`, {
      method: "HEAD",
    });
    expect(missing.status).toBe(404);
  });

  it("4. delete removes a piece", async () => {
    await postPiece("piece-gone", Buffer.from("to-be-deleted"));

    const deleted = await fetch(`${baseUrl}/pieces/piece-gone`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    expect((await fetch(`${baseUrl}/pieces/piece-gone`)).status).toBe(404);
    expect(
      (await fetch(`${baseUrl}/pieces/piece-gone`, { method: "HEAD" })).status,
    ).toBe(404);
    expect(
      (await fetch(`${baseUrl}/pieces/piece-gone`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("5. duplicate stores overwrite (last-write-wins)", async () => {
    const first = await postPiece("piece-dup", Buffer.from("version-one"));
    expect(first.status).toBe(201);

    const second = await postPiece("piece-dup", Buffer.from("version-two"));
    expect(second.status).toBe(200);

    const got = await fetch(`${baseUrl}/pieces/piece-dup`);
    expect(got.status).toBe(200);
    expect((await getBytes(got)).toString("utf8")).toBe("version-two");
  });

  it("6. rejects path traversal piece IDs", async () => {
    const unsafeIds = ["../evil", "..", ".", "a/b", "", "a..b//c"];
    for (const id of unsafeIds) {
      const res = await postPiece(id, Buffer.from("evil"));
      expect(res.status).toBe(400);
    }

    // Percent-encoded traversal stays in one URL segment: still rejected.
    for (const encoded of ["%2e%2e%2fevil", "%2e", "a%2fb", "%2fetc%2fpasswd"]) {
      const res = await fetch(`${baseUrl}/pieces/${encoded}`);
      expect(res.status).toBe(400);
    }

    // Nothing escaped the storage directory.
    const entries = await readdir(storageDir);
    expect(
      entries.every((entry) => /^[A-Za-z0-9_-]{1,128}$/.test(entry)),
    ).toBe(true);
  });

  it("7. returns stored bytes unchanged (opaque binary)", async () => {
    const palette = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const random = randomBytes(65536 + 123);
    for (const [id, bytes] of [
      ["piece-bin-palette", palette],
      ["piece-bin-random", random],
    ] as Array<[string, Buffer]>) {
      const posted = await postPiece(id, bytes);
      expect([200, 201]).toContain(posted.status);
      const got = await fetch(`${baseUrl}/pieces/${id}`);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("application/octet-stream");
      expect((await getBytes(got)).equals(bytes)).toBe(true);
    }
  });

  it("never accepts encryption keys", async () => {
    const res = await fetch(`${baseUrl}/pieces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "piece-keyed",
        data: Buffer.from("x").toString("base64"),
        key: "must-be-rejected",
      }),
    });
    expect(res.status).toBe(400);
    expect((await fetch(`${baseUrl}/pieces/piece-keyed`)).status).toBe(404);
  });

  it("exposes bounded aggregate diagnostics without piece identifiers", async () => {
    const response = await fetch(`${baseUrl}/status`);
    expect(response.status).toBe(200);
    const snapshot = await response.json() as {
      capacity: { allocatedBytes?: number; usedBytes: number; availableBytes: number };
      pieceCount: number;
      diagnostics: { metrics: unknown; events: Array<{ details: Record<string, unknown> }> };
    };
    expect(snapshot.capacity.allocatedBytes).toBeGreaterThan(0);
    expect(snapshot.capacity.usedBytes).toBeGreaterThanOrEqual(0);
    expect(snapshot.capacity.availableBytes).toBeGreaterThanOrEqual(0);
    expect(snapshot.pieceCount).toBeGreaterThan(0);
    expect(snapshot.diagnostics.events.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(snapshot)).not.toMatch(/piece-alpha|storageDir|privateKey|plaintext|ciphertext/i);
  });
});
