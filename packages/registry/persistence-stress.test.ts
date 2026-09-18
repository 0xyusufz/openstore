import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "fs/promises";
import { writeFileSync as realWriteFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import { createIdentity } from "../identity/index.js";
import { createRegistry } from "./index.js";
import { createCoordinatorInstanceIdentity } from "../coordinator-ha/index.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "openstore-065-reg-"));
}

function capacity(n: number) {
  return { allocatedBytes: n, usedBytes: 0, availableBytes: n };
}

describe("Milestone 065: coordinator persistence stress", () => {
  it("1. repeated writes stay durable and the directory stays bounded", async () => {
    const dir = await tempDir();
    const file = join(dir, "registry.json");
    const reg = createRegistry({ persistencePath: file });
    const ids = [createIdentity(), createIdentity(), createIdentity(), createIdentity(), createIdentity()];
    ids.forEach((id, i) => reg.register(`http://127.0.0.1:${4001 + i}`, id, capacity(1000 + i)));
    for (let i = 0; i < 40; i++) {
      const id = ids[i % ids.length]!;
      reg.heartbeat(id.publicKey.toString("base64"), id, capacity(1000 + (i % ids.length)));
      if (i % 10 === 0) {
        // File must always parse and match memory mid-stress (never torn).
        const parsed = JSON.parse(await readFile(file, "utf8")) as { nodes: unknown[] };
        expect(parsed.nodes).toHaveLength(5);
      }
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as { nodes: { nodeId: string }[] };
    expect(parsed.nodes).toHaveLength(5);
    expect(new Set(parsed.nodes.map((n) => n.nodeId)).size).toBe(5);
    // Bounded: only the committed file remains, no temp artifacts.
    expect(await readdir(dir)).toEqual(["registry.json"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("2. restart preserves the latest authoritative state including counters", async () => {
    const dir = await tempDir();
    const file = join(dir, "registry.json");
    const reg1 = createRegistry({ persistencePath: file });
    const id = createIdentity();
    reg1.register("http://127.0.0.1:4001", id, capacity(1000));
    reg1.heartbeat(id.publicKey.toString("base64"), id, capacity(1000));
    reg1.heartbeat(id.publicKey.toString("base64"), id, capacity(1000));
    reg1.recordStorageAudit(id.publicKey.toString("base64"), { auditId: "audit-1", healthy: 3, unhealthy: 1 });
    const before = reg1.get(id.publicKey.toString("base64"))!;
    const reg2 = createRegistry({ persistencePath: file });
    const after = reg2.get(id.publicKey.toString("base64"))!;
    expect(after).toMatchObject({
      baseUrl: "http://127.0.0.1:4001",
      available: true,
      reliability: {
        successfulHeartbeats: before.reliability.successfulHeartbeats,
        missedHeartbeats: before.reliability.missedHeartbeats,
        successfulAudits: 3,
        failedAudits: 1,
      },
    });
    // Audit idempotency keys survive restart: no double-count.
    reg2.recordStorageAudit(id.publicKey.toString("base64"), { auditId: "audit-1", healthy: 3, unhealthy: 1 });
    expect(reg2.get(id.publicKey.toString("base64"))!.reliability.successfulAudits).toBe(3);
    // Counters keep incrementing monotonically, never reset.
    reg2.heartbeat(id.publicKey.toString("base64"), id, capacity(1000));
    expect(reg2.get(id.publicKey.toString("base64"))!.reliability.successfulHeartbeats).toBe(
      before.reliability.successfulHeartbeats + 1,
    );
    expect(reg2.persistenceStatus()).toMatchObject({ enabled: true, healthy: true, degraded: false });
    await rm(dir, { recursive: true, force: true });
  });

  it("3. injected persist failure keeps the previous valid state and recovers", async () => {
    const dir = await tempDir();
    const file = join(dir, "registry.json");
    const id = createIdentity();
    let failWrites = false;
    const reg = createRegistry({
      persistencePath: file,
      persistenceIo: {
        writeFileSync: ((path: string, data: string, options: { mode: number }) => {
          if (failWrites) throw new Error("injected disk failure");
          realWriteFileSync(path, data, options);
        }) as never,
      },
    });
    reg.register("http://127.0.0.1:4001", id, capacity(1000));
    const good = await readFile(file, "utf8");
    failWrites = true;
    reg.heartbeat(id.publicKey.toString("base64"), id, capacity(1000));
    expect(reg.persistenceStatus()).toMatchObject({ degraded: true, lastWriteOutcome: "error" });
    // Previous valid state intact, in-memory operation continued.
    expect(await readFile(file, "utf8")).toBe(good);
    expect(JSON.parse(good).nodes).toHaveLength(1);
    failWrites = false;
    reg.heartbeat(id.publicKey.toString("base64"), id, capacity(1000));
    expect(reg.persistenceStatus()).toMatchObject({ degraded: false, lastWriteOutcome: "success" });
    expect(JSON.parse(await readFile(file, "utf8")).nodes).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("4. planted stale temps are swept on startup and load succeeds", async () => {
    const dir = await tempDir();
    const file = join(dir, "registry.json");
    const reg = createRegistry({ persistencePath: file });
    const id = createIdentity();
    reg.register("http://127.0.0.1:4001", id, capacity(1000));
    await writeFile(join(dir, "registry.json.tmp.deadbeef"), "partial");
    await writeFile(join(dir, "registry.json.tmp-1234-5678"), "partial");
    await writeFile(join(dir, "unrelated.txt"), "keep");
    const reg2 = createRegistry({ persistencePath: file });
    expect(reg2.list()).toHaveLength(1);
    expect((await readdir(dir)).sort()).toEqual(["registry.json", "unrelated.txt"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("8. corrupt/missing persistence fails closed and cannot authorize placement", async () => {
    const dir = await tempDir();
    const file = join(dir, "registry.json");
    const reg1 = createRegistry({ persistencePath: file });
    reg1.register("http://127.0.0.1:4001", createIdentity(), capacity(1000));
    await writeFile(file, "{corrupt", "utf8");
    const reg2 = createRegistry({ persistencePath: file });
    expect(reg2.persistenceStatus()).toMatchObject({ degraded: true, lastLoadOutcome: "invalid" });
    expect(reg2.list()).toHaveLength(0);
    expect(reg2.getAvailableEndpoints()).toHaveLength(0);
    const missing = createRegistry({ persistencePath: join(dir, "absent.json") });
    expect(missing.persistenceStatus()).toMatchObject({ lastLoadOutcome: "missing", degraded: false });
    expect(missing.list()).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("6. node and instance identities are stable across restart", async () => {
    const dir = await tempDir();
    const file = join(dir, "registry.json");
    const reg1 = createRegistry({ persistencePath: file });
    const a = createIdentity();
    const b = createIdentity();
    reg1.register("http://127.0.0.1:4001", a, capacity(1000));
    reg1.register("http://127.0.0.1:4002", b, capacity(2000));
    const before = reg1.list().map((r) => r.nodeId).sort();
    const reg2 = createRegistry({ persistencePath: file });
    expect(reg2.list().map((r) => r.nodeId).sort()).toEqual(before);
    // Instance derivation is deterministic: same key, same identity, across recreations.
    expect(createCoordinatorInstanceIdentity(a.publicKey).instanceId).toBe(
      createCoordinatorInstanceIdentity(Buffer.from(a.publicKey)).instanceId,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("9. interleaved concurrent mutations never tear the file", async () => {
    const dir = await tempDir();
    const file = join(dir, "registry.json");
    const reg = createRegistry({ persistencePath: file });
    const ids = Array.from({ length: 6 }, () => createIdentity());
    for (let i = 0; i < 60; i++) {
      const id = ids[i % ids.length]!;
      const op = i % 4;
      if (op === 0) {
        try { reg.register(`http://127.0.0.1:${4001 + (i % ids.length)}`, id, capacity(1000)); } catch {}
      } else if (op === 1) {
        try { reg.heartbeat(id.publicKey.toString("base64"), id, capacity(1000)); } catch {}
      } else if (op === 2) {
        try { reg.recordStorageAudit(id.publicKey.toString("base64"), { auditId: `a-${i}`, healthy: 1, unhealthy: 0 }); } catch {}
      } else {
        try { reg.unregister(id.publicKey.toString("base64"), id); } catch {}
      }
      if (i % 5 === 0) {
        const parsed = JSON.parse(await readFile(file, "utf8")) as { nodes: unknown[] };
        expect(parsed.nodes.length).toBe(reg.list().length);
      }
    }
    expect(JSON.parse(await readFile(file, "utf8")).nodes.length).toBe(reg.list().length);
    expect((await readdir(dir)).sort()).toEqual(["registry.json"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("10. repeated restart cycles converge without regressing state", async () => {
    const dir = await tempDir();
    const file = join(dir, "registry.json");
    const ids = [createIdentity(), createIdentity(), createIdentity()];
    for (let cycle = 0; cycle < 5; cycle++) {
      const reg = createRegistry({ persistencePath: file });
      ids.forEach((id, i) => {
        try { reg.register(`http://127.0.0.1:${4001 + i}`, id, capacity(1000 + cycle)); } catch {}
        try { reg.heartbeat(id.publicKey.toString("base64"), id, capacity(1000 + cycle)); } catch {}
      });
      expect(reg.list()).toHaveLength(3);
    }
    const final = createRegistry({ persistencePath: file });
    expect(final.list()).toHaveLength(3);
    expect(final.list().every((r) => r.capacity.allocatedBytes === 1004)).toBe(true);
    expect((await readdir(dir)).sort()).toEqual(["registry.json"]);
    await rm(dir, { recursive: true, force: true });
  });
});
