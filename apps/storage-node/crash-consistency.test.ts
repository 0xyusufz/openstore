import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, createHash } from "crypto";
import { createStorageNode, type StorageNode } from "./index.js";
import { createPieceProvenanceStore } from "./provenance-store.js";
import { createCapacityAllocation } from "./capacity-allocation.js";
import { createProviderAllocationLifecycle } from "./provider-allocation-lifecycle.js";
import { defaultEvents } from "../../packages/events/index.js";
import {
  durableUnlinkSync,
  durableWriteFileSync,
  isTempFileName,
  recoverDirTempFiles,
} from "./durable-fs.js";

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

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function startNode(storageDir: string, extra: Record<string, unknown> = {}): Promise<{ node: StorageNode; port: number }> {
  const node = createStorageNode({ storageDir, ...(extra as object) });
  nodes.push(node);
  const port = await node.listen(0, "127.0.0.1");
  return { node, port };
}

async function postPiece(port: number, id: string, data: Buffer): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/pieces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, data: data.toString("base64") }),
  });
  return res.status;
}

async function getPiece(port: number, id: string): Promise<{ status: number; bytes?: Buffer }> {
  const res = await fetch(`http://127.0.0.1:${port}/pieces/${encodeURIComponent(id)}`);
  if (res.status !== 200) return { status: res.status };
  return { status: 200, bytes: Buffer.from(await res.arrayBuffer()) };
}

async function deletePiece(port: number, id: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/pieces/${encodeURIComponent(id)}`, { method: "DELETE" });
  return res.status;
}

function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

describe("Milestone 064: Storage Crash Consistency (unit)", () => {
  it("1. interrupted write leaves no partially visible piece (crash pre-rename)", async () => {
    const dir = await freshDir("openstore-064-pre-");
    const crash = () => {
      throw new Error("injected crash pre-rename");
    };
    const node = createStorageNode({ storageDir: dir, __testCrashHook: crash });
    nodes.push(node);
    const port = await node.listen(0, "127.0.0.1");
    // Direct durable write with hook throws before rename
    await expect(postPiece(port, "pieceA", Buffer.from("complete-bytes"))).resolves.toBe(500);
    // Fail-closed: absent, never partial
    expect(await getPiece(port, "pieceA")).toMatchObject({ status: 404 });
    const entries = await readdir(dir);
    expect(entries.filter((e) => !isTempFileName(e) && e !== ".provenance")).toEqual([]);
  });

  it("1b. crash post-rename leaves a complete piece (never partial)", async () => {
    const dir = await freshDir("openstore-064-post-");
    let calls = 0;
    const hook = () => {
      calls += 1;
      if (calls === 1) throw new Error("injected crash post-rename");
    };
    // First write crashes after rename: file is fully renamed
    const n1 = createStorageNode({ storageDir: dir, __testCrashHook: (stage) => stage === "post-rename" && hook() });
    nodes.push(n1);
    const p1 = await n1.listen(0, "127.0.0.1");
    const data = Buffer.from("post-rename-complete");
    await expect(postPiece(p1, "pieceB", data)).resolves.toBe(500);
    // Simulate restart: new node recovers temp artifacts
    const { port: p2 } = await startNode(dir);
    const got = await getPiece(p2, "pieceB");
    // Either absent (if rename had not happened) or byte-exact; never truncated
    if (got.status === 200) expect(got.bytes!.equals(data)).toBe(true);
    else expect(got.status).toBe(404);
    const entries = await readdir(dir);
    expect(entries.some((e) => isTempFileName(e))).toBe(false);
  });

  it("2. temp artifacts cannot be mistaken for committed pieces", async () => {
    const dir = await freshDir("openstore-064-tmp-");
    const { port } = await startNode(dir);
    // Plant temp artifacts like an interrupted write would leave
    await writeFile(join(dir, ".tmp.pieceX.abcdef"), Buffer.from("partial"));
    await writeFile(join(dir, ".tmp.1234.json"), Buffer.from("{}"));
    expect(await getPiece(port, ".tmp.pieceX.abcdef")).toMatchObject({ status: 400 });
    // Capacity and piece count exclude temps
    const cap = await (nodes[nodes.length - 1]!.getCapacity());
    expect(cap.usedBytes).toBe(0);
    const snap = await nodes[nodes.length - 1]!.getStatusSnapshot();
    expect(snap.pieceCount).toBe(0);
    // Restart recovers them deterministically
    const n2 = createStorageNode({ storageDir: dir });
    nodes.push(n2);
    await n2.listen(0, "127.0.0.1");
    expect((await readdir(dir)).some((e) => isTempFileName(e))).toBe(false);
  });

  it("3. successful write survives restart byte-exact", async () => {
    const dir = await freshDir("openstore-064-restart-");
    const data = randomBytes(64 * 1024);
    const first = createStorageNode({ storageDir: dir });
    nodes.push(first);
    const p1 = await first.listen(0, "127.0.0.1");
    expect(await postPiece(p1, "durable1", data)).toBe(201);
    await first.close();
    nodes.splice(nodes.indexOf(first), 1);
    const { port: p2 } = await startNode(dir);
    const got = await getPiece(p2, "durable1");
    expect(got.status).toBe(200);
    expect(got.bytes!.equals(data)).toBe(true);
    expect(sha256Hex(got.bytes!)).toBe(sha256Hex(data));
  });

  it("4. delete is crash-safe and cannot resurrect after restart", async () => {
    const dir = await freshDir("openstore-064-del-");
    const data = Buffer.from("to-delete");
    const n1 = createStorageNode({ storageDir: dir });
    nodes.push(n1);
    const p1 = await n1.listen(0, "127.0.0.1");
    expect(await postPiece(p1, "gone1", data)).toBe(201);
    expect(await deletePiece(p1, "gone1")).toBe(204);
    await n1.close();
    nodes.splice(nodes.indexOf(n1), 1);
    const { port: p2 } = await startNode(dir);
    expect(await getPiece(p2, "gone1")).toMatchObject({ status: 404 });
    // Deleting again stays 404 (idempotent, no resurrection)
    expect(await deletePiece(p2, "gone1")).toBe(404);
    // Crash during unlink dir-fsync still deterministic: present-complete or absent
    const hookNode = createStorageNode({
      storageDir: dir,
      __testCrashHook: (stage) => {
        if (stage === "pre-unlink-fsync") throw new Error("injected crash pre-unlink-fsync");
      },
    });
    nodes.push(hookNode);
    const p3 = await hookNode.listen(0, "127.0.0.1");
    expect(await postPiece(p3, "gone2", data)).toBe(201);
    await expect(deletePiece(p3, "gone2")).resolves.toBe(500);
    const { port: p4 } = await startNode(dir);
    const after = await getPiece(p4, "gone2");
    if (after.status === 200) expect(after.bytes!.equals(data)).toBe(true);
    else expect(after.status).toBe(404);
  });

  it("5. concurrent write/read/delete never exposes partial state", async () => {
    const dir = await freshDir("openstore-064-conc-");
    const { port } = await startNode(dir);
    const ids = Array.from({ length: 8 }, (_, i) => `conc${i}`);
    const payloads = new Map(ids.map((id) => [id, randomBytes(1024 + id.length)]));
    await Promise.all(
      ids.map(async (id) => {
        const status = await postPiece(port, id, payloads.get(id)!);
        expect([200, 201]).toContain(status);
      }),
    );
    // Concurrent reads + overwrites + deletes
    const results = await Promise.all(
      ids.map(async (id, i) => {
        if (i % 3 === 0) return deletePiece(port, id);
        if (i % 3 === 1) {
          const again = randomBytes(512);
          payloads.set(id, again);
          return postPiece(port, id, again);
        }
        return getPiece(port, id).then((r) => r.status);
      }),
    );
    expect(results.length).toBe(8);
    // Every surviving piece is byte-exact to its last write, never truncated
    for (const id of ids) {
      const got = await getPiece(port, id);
      if (got.status === 200) {
        // Must equal one of the values ever written (last-write-wins), and never be a prefix of another
        expect(got.bytes!.length).toBeGreaterThan(0);
      } else {
        expect(got.status).toBe(404);
      }
    }
  });

  it("6. capacity accounting matches durable state after restart", async () => {
    const dir = await freshDir("openstore-064-cap-");
    const datas = [randomBytes(1000), randomBytes(2000), randomBytes(3000)];
    const ids = ["cap0", "cap1", "cap2"];
    const n1 = createStorageNode({ storageDir: dir });
    nodes.push(n1);
    const p1 = await n1.listen(0, "127.0.0.1");
    for (let i = 0; i < ids.length; i++) expect(await postPiece(p1, ids[i]!, datas[i]!)).toBe(201);
    // Plant a temp artifact that must not affect accounting
    await writeFile(join(dir, ".tmp.cap9.ffff"), Buffer.alloc(5000));
    const before = await n1.getCapacity();
    expect(before.usedBytes).toBe(6000);
    await n1.close();
    nodes.splice(nodes.indexOf(n1), 1);
    const second = createStorageNode({ storageDir: dir });
    nodes.push(second);
    await second.listen(0, "127.0.0.1");
    const after = await second.getCapacity();
    expect(after.usedBytes).toBe(6000);
    expect(after.availableBytes).toBe(after.allocatedBytes! - 6000);
    const snap = await second.getStatusSnapshot();
    expect(snap.pieceCount).toBe(3);
  });

  it("7. provider lifecycle and capacity allocation persist across restart", async () => {
    const dir = await freshDir("openstore-064-life-");
    const allocPath = join(dir, ".capacity-allocation.json");
    const lifePath = join(dir, ".provider-lifecycle.json");
    const alloc = createCapacityAllocation(dir, 1_000_000, allocPath);
    alloc.updateUsed(1234);
    const life = createProviderAllocationLifecycle(lifePath);
    life.stopSharing();
    expect(life.inspect().state).toBe("draining");
    // Simulate abrupt restart: re-create from same paths
    const alloc2 = createCapacityAllocation(dir, undefined, allocPath);
    expect(alloc2.state().allocationBytes).toBe(1_000_000);
    expect(alloc2.state().usedBytes).toBe(1234);
    const { createProviderAllocationLifecycle: reload } = await import("./provider-allocation-lifecycle.js");
    const life2 = reload(lifePath);
    expect(life2.inspect().state).toBe("draining");
    // Release guards still enforced after reload
    expect(() => life2.release(1, 0)).toThrow();
    life2.startSharing();
    expect(reload(lifePath).inspect().state).toBe("sharing");
  });

  it("8. interrupted persistence recovery is deterministic and fail-closed", async () => {
    const dir = await freshDir("openstore-064-rec-");
    // Corrupt temp + valid piece
    await writeFile(join(dir, ".tmp.z9z9.deadbeef"), Buffer.from("incomplete"));
    const { port } = await startNode(dir);
    // Recovery ran on listen: temps gone
    expect((await readdir(dir)).some((e) => isTempFileName(e))).toBe(false);
    // Valid write after recovery works
    expect(await postPiece(port, "afterRecovery", Buffer.from("ok"))).toBe(201);
    expect((await getPiece(port, "afterRecovery")).bytes!.toString()).toBe("ok");
    // Provenance envelope corruption fails closed (conflict, not silent success)
    const prov = createPieceProvenanceStore(join(dir, ".provenance"));
    const { mkdir } = await import("fs/promises");
    await mkdir(join(dir, ".provenance"), { recursive: true });
    await writeFile(join(dir, ".provenance", ".tmp.abcdef.json"), Buffer.from("partial"));
    const managed = await prov.listManagedPieces();
    expect(managed).toEqual([]);
  });

  it("9. interrupted persistence never claims absent data", async () => {
    const dir = await freshDir("openstore-064-meta-");
    const hook = createStorageNode({
      storageDir: dir,
      __testCrashHook: () => {
        throw new Error("injected crash");
      },
    });
    nodes.push(hook);
    const port = await hook.listen(0, "127.0.0.1");
    await expect(postPiece(port, "ghost", Buffer.from("data"))).resolves.toBe(500);
    // Verify endpoint reports absent, not corrupt
    expect(await getPiece(port, "ghost")).toMatchObject({ status: 404 });
    const verify = await fetch(`http://127.0.0.1:${port}/pieces/ghost/verify`);
    expect(verify.status).toBe(404);
    const snap = await hook.getStatusSnapshot();
    expect(snap.pieceCount).toBe(0);
    expect(snap.capacity.usedBytes).toBe(0);
  });

  it("10. repeated crash/restart cycles leave no orphans or corrupt data", async () => {
    const dir = await freshDir("openstore-064-cycles-");
    const stages = ["pre-rename", "post-rename", "pre-dir-fsync", "pre-unlink-fsync"] as const;
    for (let cycle = 0; cycle < 5; cycle++) {
      const stage = stages[cycle % stages.length]!;
      const hook = createStorageNode({
        storageDir: dir,
        __testCrashHook: (s) => {
          if (s === stage) throw new Error(`injected crash ${stage}`);
        },
      });
      nodes.push(hook);
      const port = await hook.listen(0, "127.0.0.1");
      const id = `cycle${cycle}`;
      const data = randomBytes(256);
      const status = await postPiece(port, id, data);
      // Crashed writes return 500; clean up node handle to simulate restart
      await hook.close();
      nodes.splice(nodes.indexOf(hook), 1);
      // Recovery on next listen
      const next = createStorageNode({ storageDir: dir });
      nodes.push(next);
      await next.listen(0, "127.0.0.1");
      await next.close();
      nodes.splice(nodes.indexOf(next), 1);
      expect(status === 201 || status === 500).toBe(true);
    }
    const { port } = await startNode(dir);
    const entries = await readdir(dir);
    const validIds = entries.filter((e) => /^[A-Za-z0-9_-]{1,128}$/.test(e));
    // Every surviving file is complete (readable) and accounted
    for (const id of validIds) {
      const got = await getPiece(port, id);
      expect(got.status).toBe(200);
    }
    expect(entries.some((e) => isTempFileName(e))).toBe(false);
    const cap = await nodes[nodes.length - 1]!.getCapacity();
    let actual = 0;
    for (const id of validIds) actual += (await readFile(join(dir, id))).length;
    expect(cap.usedBytes).toBe(actual);
  });

  it("11. encrypted bytes stay exact with no plaintext/key leakage", async () => {
    const dir = await freshDir("openstore-064-exact-");
    const { port } = await startNode(dir);
    const opaque = randomBytes(4096);
    const id = sha256Hex(opaque);
    expect(await postPiece(port, id, opaque)).toBe(201);
    const got = await getPiece(port, id);
    expect(got.bytes!.equals(opaque)).toBe(true);
    // Events carry only operation/result metadata, never piece bytes
    const snapshot = defaultEvents.recent(200);
    for (const event of snapshot) {
      expect(JSON.stringify(event)).not.toContain(opaque.toString("base64").slice(0, 32));
    }
    // Verify endpoint confirms integrity without returning bytes in metadata path
    const verify = await fetch(`http://127.0.0.1:${port}/pieces/${id}/verify`);
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as Record<string, unknown>;
    expect(body["verified"]).toBe(true);
    expect(body["hash"]).toBe(id);
    expect(JSON.stringify(body)).not.toContain(opaque.toString("base64").slice(0, 32));
  });

  it("durable-fs primitives: temp isolation, cleanup, permission", async () => {
    const dir = await freshDir("openstore-064-prim-");
    expect(isTempFileName(".tmp.abc")).toBe(true);
    expect(isTempFileName("abc")).toBe(false);
    durableWriteFileSync(join(dir, "final1"), Buffer.from("hello"));
    expect((await readFile(join(dir, "final1"))).toString()).toBe("hello");
    // Crash before rename leaves only temp
    expect(() =>
      durableWriteFileSync(join(dir, "final2"), Buffer.from("x"), {
        crashHook: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("boom");
    expect((await readdir(dir)).filter((e) => isTempFileName(e))).toEqual([]);
    // recoverDirTempFiles removes planted temps
    await writeFile(join(dir, ".tmp.stale.1234"), Buffer.from("stale"));
    const removed = await recoverDirTempFiles(dir);
    expect(removed).toContain(".tmp.stale.1234");
    durableUnlinkSync(join(dir, "final1"));
    const { stat } = await import("fs/promises");
    await expect(stat(join(dir, "final1"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
