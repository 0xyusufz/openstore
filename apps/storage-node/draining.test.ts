/**
 * Storage Node Draining + Resizable Quota Tests (OPENSTORE-029)
 *
 * Draining nodes refuse new placements (503) while continuing to serve
 * existing pieces; allocation can be resized at runtime.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createStorageNode } from "./index.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openstore-drain-"));
}

function pieceBody(id: string, data: Buffer): string {
  return JSON.stringify({ id, data: data.toString("base64") });
}

async function postPiece(port: number, id: string, data: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/pieces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: pieceBody(id, data),
  });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch {}
  return { status: res.status, json };
}

describe("storage node draining and quota (OPENSTORE-029)", () => {
  it("1. draining rejects stores but keeps serving reads", async () => {
    const dir = await tempDir();
    const node = createStorageNode({ storageDir: dir });
    const port = await node.listen(0, "127.0.0.1");
    try {
      expect(node.isDraining()).toBe(false);
      const data = randomBytes(64);
      const stored = await postPiece(port, "piece-aaa", data);
      expect([200, 201]).toContain(stored.status);

      node.setDraining(true);
      expect(node.isDraining()).toBe(true);

      const getRes = await fetch(`http://127.0.0.1:${port}/pieces/piece-aaa`);
      expect(getRes.status).toBe(200);
      expect(Buffer.from(await getRes.arrayBuffer()).equals(data)).toBe(true);

      const refused = await postPiece(port, "piece-bbb", randomBytes(64));
      expect(refused.status).toBe(503);
      expect(String(refused.json["error"])).toMatch(/draining/i);

      // Leaving draining mode accepts stores again.
      node.setDraining(false);
      expect(node.isDraining()).toBe(false);
      const again = await postPiece(port, "piece-bbb", randomBytes(64));
      expect([200, 201]).toContain(again.status);
    } finally {
      await node.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. allocation resizes at runtime and stays enforced", async () => {
    const dir = await tempDir();
    const node = createStorageNode({ storageDir: dir, capacityBytes: 2048 });
    const port = await node.listen(0, "127.0.0.1");
    try {
      expect(node.capacityBytes).toBe(2048);
      expect((await postPiece(port, "small-1", randomBytes(64))).status).toBeLessThan(300);

      // Growing the quota sticks and serves bigger writes.
      node.setCapacityBytes(1_000_000);
      expect(node.capacityBytes).toBe(1_000_000);
      expect((await postPiece(port, "big-1", randomBytes(4096))).status).toBeLessThan(300);

      // Invalid resizes are rejected without touching the quota.
      expect(() => node.setCapacityBytes(0)).toThrow(/positive integer/i);
      expect(() => node.setCapacityBytes(-10)).toThrow(/positive integer/i);
      expect(() => node.setCapacityBytes(1.5)).toThrow(/positive integer/i);
      expect(node.capacityBytes).toBe(1_000_000);
    } finally {
      await node.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
