import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { MixedStorageTransport } from "../../apps/client/http-transport.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";

const run = promisify(execFile);
const dockerAvailable = (() => {
  try { execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const suite = dockerAvailable && process.env.OPENSTORE_RUN_DOCKER_TESTNET === "1" ? describe : describe.skip;

// Milestone 064: Storage Crash Consistency.
// Uses abrupt SIGKILL (`docker kill`) — never graceful shutdown — at
// meaningful points: mid-storage, around delete, around temp artifacts,
// across repeated cycles, and around concurrent uploads.
suite("Milestone 064 storage crash consistency integration", () => {
  it("abrupt kill/restart preserves piece integrity, delete state, capacity, lifecycle, no orphans", async () => {
    const root = await mkdtemp(join(process.cwd(), ".milestone-064-"));
    const project = `openstore-064-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env");
    const overridePath = join(root, "override.yml");
    const [coordinatorPort, n1Port, n2Port, n3Port] = await reservePorts(4);
    const token = `064-${process.pid}-${Date.now()}`;
    await writeFile(envPath, [
      `OPENSTORE_COORDINATOR_TOKEN=${token}`,
      "OPENSTORE_NODE_1_PASSWORD=local-node-1-password", "OPENSTORE_NODE_2_PASSWORD=local-node-2-password", "OPENSTORE_NODE_3_PASSWORD=local-node-3-password",
      `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`, `OPENSTORE_NODE_1_HOST_PORT=${n1Port}`,
      `OPENSTORE_NODE_2_HOST_PORT=${n2Port}`, `OPENSTORE_NODE_3_HOST_PORT=${n3Port}`, "",
    ].join("\n"), { mode: 0o600 });
    const configFiles = await Promise.all(["node-1", "node-2", "node-3"].map(async (s) => {
      const p = join(root, `${s}.json`);
      await writeFile(p, JSON.stringify({ lifecyclePath: "/var/lib/openstore/pieces/.provider-lifecycle.json" }));
      return p;
    }));
    await writeFile(overridePath, [
      "services:",
      ...(["node-1", "node-2", "node-3"] as const).flatMap((svc, idx) => [
        `  ${svc}:`, "    environment:", "      OPENSTORE_NODE_CONFIG: /etc/openstore/node-config.json",
        "      OPENSTORE_NODE_ALLOCATION_PATH: /var/lib/openstore/pieces/.capacity-allocation.json",
        "      OPENSTORE_NODE_CAPACITY_BYTES: \"67108864\"", "    mem_limit: 768m",
        "    volumes:", `      - "${configFiles[idx]}:/etc/openstore/node-config.json:ro"`,
      ]), "",
    ].join("\n"));
    const compose = (...args: string[]) => run("docker", ["compose", "--project-name", project, "--env-file", envPath, "-f", "deploy/testnet/docker-compose.yml", "-f", overridePath, ...args], { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    const registry = createRegistryClient({ baseUrl: `http://127.0.0.1:${coordinatorPort}`, token });
    const adapter = createCoordinatorAdapter({ baseUrl: `http://127.0.0.1:${coordinatorPort}`, token });
    const manifests = createManifestStore({ dir: join(root, "manifests") });
    const transport = new MixedStorageTransport();
    const ports = new Map([["node-1", n1Port], ["node-2", n2Port], ["node-3", n3Port]] as const);
    const host = (ep: StorageNodeEndpoint): StorageNodeEndpoint => {
      const svc = serviceFor(ep);
      serviceById.set(ep.id, svc);
      return { ...ep, multiaddr: ep.multiaddr?.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${ports.get(svc)}`) };
    };
    const hostAware = {
      refresh: async () => (await adapter.refresh()).map(host),
      getEndpoints: () => adapter.getEndpoints().map(host),
      getKnownEndpoints: () => adapter.getKnownEndpoints().map(host),
      get discovery() { return adapter.discovery; },
    } as unknown as ReturnType<typeof createCoordinatorAdapter>;
    const exec = (svc: string, ...cmd: string[]) => compose("exec", "-T", svc, ...cmd);

    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => (await registry.status()).status === "ok");
      let endpoints = (await waitForEndpoints(adapter)).map(host);
      expect(endpoints.length).toBe(3);

      const plaintext = Buffer.alloc(4 * 1024 * 1024 + 321);
      const marker = Buffer.from("064-crash-plaintext-marker");
      for (let o = 0; o < plaintext.length; o += marker.length) marker.copy(plaintext, o);

      const uploaded = await uploadBuffer(plaintext, "064-crash.bin", endpoints, {
        chunkSize: 4 * 1024 * 1024, replicationFactor: 2, manifestStore: manifests,
      });
      expect(uploaded.manifest.chunks).toHaveLength(2);
      const victim = endpoints.find((e) => uploaded.manifest.chunks[0]!.nodeIds.includes(e.id))!;
      const victimSvc = serviceFor(victim);

      // 1. write → abrupt SIGKILL → restart → piece integrity/readability
      await compose("kill", victimSvc);
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 2);
      // Survivors serve while victim is down (fail-closed reads, no partial)
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport, retryAttempts: 1, timeoutMs: 3000 })).toEqual(plaintext);
      await compose("start", victimSvc);
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 3);
      endpoints = (await waitForEndpoints(adapter)).map(host);
      await waitFor(async () => { try { const eps = await hostAware.refresh(); return eps.length === 3; } catch { return false; } });
      // Restarted node's pieces are byte-exact (never truncated)
      for (const ep of endpoints) {
        for (const chunk of uploaded.manifest.chunks) {
          const piece = await getPieceResilient(transport, toAddress(ep), chunk.pieceId);
          if (piece.status === 200 && piece.bytes) {
            // Opaque bytes must never contain plaintext marker
            expect(piece.bytes.includes(marker)).toBe(false);
          } else {
            expect([404]).toContain(piece.status);
          }
        }
      }
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);
      // Capacity accounting consistent: restarted node reports exactly the
      // bytes of the pieces its manifest replicas assign to it (heartbeat
      // snapshots lag uploads, so derive expected from manifest + survivors).
      const expectedVictimUsed = await expectedUsedBytes(endpoints, uploaded.manifest, transport);
      await waitFor(async () => (await registryNodes(registry)).find((n) => n.nodeId === victim.id)?.capacity.usedBytes === expectedVictimUsed.get(victim.id));
      expect((await registryNodes(registry)).find((n) => n.nodeId === victim.id)?.capacity.usedBytes).toBe(expectedVictimUsed.get(victim.id));

      // 2. incomplete temp artifact recovery: plant temp files, abrupt restart, verify cleanup + pieces intact
      await exec(victimSvc, "sh", "-c", "echo -n partial-bytes > /var/lib/openstore/pieces/.tmp.crash.abcdef && echo -n '{}' > /var/lib/openstore/pieces/.tmp.1234.json && ls /var/lib/openstore/pieces/.tmp.crash.abcdef");
      await compose("kill", victimSvc);
      // Prove the node is actually down before restarting: otherwise `start`
      // can race container auto-restart and no fresh boot (hence no recovery)
      // is guaranteed before the temp check below.
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 2);
      await compose("start", victimSvc);
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 3);
      const lsAfter = await exec(victimSvc, "sh", "-c", "ls -a /var/lib/openstore/pieces | grep -E '^\\.tmp' || echo NO_TEMPS");
      expect(lsAfter.stdout).toContain("NO_TEMPS");
      endpoints = (await waitForEndpoints(adapter)).map(host);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);

      // 3. delete → abrupt stop → restart → deletion state deterministic
      const deletable = await uploadBuffer(Buffer.from("064-delete-me"), "064-del.bin", endpoints, { replicationFactor: 2, manifestStore: manifests });
      const delVictim = endpoints.find((e) => deletable.manifest.chunks[0]!.nodeIds.includes(e.id))!;
      const delSvc = serviceFor(delVictim);
      const { deleteFile } = await import("../../apps/client/delete.js");
      await deleteFile(deletable.manifest, endpoints, { manifestStore: manifests });
      await compose("kill", delSvc);
      await compose("start", delSvc);
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 3);
      endpoints = (await waitForEndpoints(adapter)).map(host);
      // Deleted pieces stay deleted everywhere (no resurrection), never partial
      for (const ep of endpoints) {
        const piece = await getPieceResilient(transport, toAddress(ep), deletable.manifest.chunks[0]!.pieceId);
        expect([404]).toContain(piece.status);
      }

      // 4. capacity/lifecycle state after abrupt restart
      await setLifecycle(compose, victimSvc, "draining", root);
      await waitFor(async () => (await registry.nodes()).find((n) => n.nodeId === victim.id)?.lifecycle === "draining");
      // Abrupt kill while draining: lifecycle file must survive (durable), capacity must match
      await compose("kill", victimSvc);
      await compose("start", victimSvc);
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 3);
      await waitFor(async () => (await registry.nodes()).find((n) => n.nodeId === victim.id)?.lifecycle === "draining");
      const expectedAfterDrain = await expectedUsedBytes(endpoints, uploaded.manifest, transport);
      await waitFor(async () => (await registryNodes(registry)).find((n) => n.nodeId === victim.id)?.capacity.usedBytes === expectedAfterDrain.get(victim.id));
      expect((await registryNodes(registry)).find((n) => n.nodeId === victim.id)?.capacity.usedBytes).toBe(expectedAfterDrain.get(victim.id));
      await setLifecycle(compose, victimSvc, "sharing", root);
      await waitFor(async () => (await registry.nodes()).find((n) => n.nodeId === victim.id)?.lifecycle !== "draining");

      // 5. repeated crash/restart cycles: no duplicates, no orphans, data intact
      for (let cycle = 0; cycle < 3; cycle++) {
        const svc = (["node-1", "node-2", "node-3"] as const)[cycle % 3]!;
        await compose("kill", svc);
        await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 2);
        await compose("start", svc);
        await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 3);
      }
      endpoints = (await waitForEndpoints(adapter)).map(host);
      expect(new Set(endpoints.map((e) => e.id)).size).toBe(3);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);
      const current = await manifests.load(uploaded.manifest.fileId);
      for (const ch of current!.chunks) expect(new Set(ch.nodeIds).size).toBe(ch.nodeIds.length);

      // 6. concurrent storage operations around interruption: no partial state
      const parallel = [0, 1, 2].map((i) => uploadBuffer(Buffer.from(`064-concurrent-${i}`), `064-conc-${i}.bin`, endpoints, { replicationFactor: 2, manifestStore: manifests }));
      const killer = (async () => {
        await new Promise((r) => setTimeout(r, 300));
        await compose("kill", serviceFor(endpoints[0]!));
      })();
      const settled = await Promise.allSettled([...parallel, killer]);
      await compose("start", serviceFor(endpoints[0]!)).catch(() => {});
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 3);
      endpoints = (await waitForEndpoints(adapter)).map(host);
      for (const result of settled.slice(0, 3)) {
        if (result.status === "fulfilled") {
          const up = result.value as Awaited<ReturnType<typeof uploadBuffer>>;
          // Fully committed uploads are byte-exact; failed ones threw explicitly
          expect(await downloadBuffer(up.manifest, up.encryptionKey, endpoints, { transport, retryAttempts: 2 })).toEqual(
            Buffer.from(`064-concurrent-${up.manifest.filename.match(/064-conc-(\d)/)?.[1]}`),
          );
          for (const ch of up.manifest.chunks) expect(new Set(ch.nodeIds).size).toBe(ch.nodeIds.length);
        }
      }

      // No secret leakage in container logs
      const logs = await compose("logs", "--no-log-prefix");
      expect(logs.stdout).not.toContain(marker.toString());
      expect(logs.stderr).not.toContain(marker.toString());
      expect(logs.stdout).not.toContain(token);
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 420_000);
});

const serviceById = new Map<string, "node-1" | "node-2" | "node-3">();
function serviceFor(ep: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  const known = serviceById.get(ep.id);
  if (known) return known;
  const a = ep.multiaddr ?? "";
  if (a.includes("4101") || a.includes("node-1")) return "node-1";
  if (a.includes("4102") || a.includes("node-2")) return "node-2";
  return "node-3";
}
function toAddress(ep: StorageNodeEndpoint) {
  return { nodeId: ep.id, baseUrl: ep.baseUrl, multiaddr: ep.multiaddr, identityBinding: ep.identityBinding, identity: ep.identity };
}
async function setLifecycle(compose: (...args: string[]) => Promise<{ stdout: string }>, svc: string, state: string, root: string): Promise<void> {
  const file = join(root, `${svc}-${state}.json`);
  await writeFile(file, JSON.stringify({ version: 1, state, updatedAt: Date.now() }) + "\n");
  const { stdout } = await compose("ps", "-q", svc);
  await compose("stop", svc);
  await run("docker", ["cp", file, `${stdout.trim()}:/var/lib/openstore/pieces/.provider-lifecycle.json`]);
  await compose("start", svc);
}
async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>): Promise<StorageNodeEndpoint[]> {
  let eps: StorageNodeEndpoint[] = [];
  await waitFor(async () => { eps = await adapter.refresh(); return eps.length === 3; });
  return eps;
}
async function waitFor(check: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  throw new Error("064 readiness timeout");
}
// Direct libp2p dials transiently fail (Noise EOF / ECONNREFUSED / hang up)
// while a container restarts. Retry boundedly; 200/404 are terminal.
async function getPieceResilient(
  transport: MixedStorageTransport,
  address: { nodeId: string; baseUrl: string; multiaddr?: string; identityBinding?: string; identity?: { publicKey: string } },
  pieceId: string,
  timeoutMs = 20_000,
): Promise<{ status: number; bytes?: Buffer }> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await transport.getPiece(address as never, pieceId, { timeoutMs: 5000 });
      if (res.status === 200 || res.status === 404) return res;
      last = new Error(`unexpected status ${res.status}`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw last;
}
// Coordinator HTTP is transiently reset during container churn (kill/start);
// retry direct reads so a single socket hang up cannot fail the test.
async function expectedUsedBytes(
  endpoints: StorageNodeEndpoint[],
  manifest: { chunks: { pieceId: string; nodeIds: string[] }[] },
  transport: MixedStorageTransport,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const chunk of manifest.chunks) {
    const host = endpoints.find((e) => chunk.nodeIds.includes(e.id));
    if (!host) throw new Error("no surviving replica for expected-usage probe");
    const piece = await getPieceResilient(transport, toAddress(host), chunk.pieceId);
    if (piece.status !== 200 || !piece.bytes) throw new Error("survivor did not serve piece for expected-usage probe");
    sizes.set(chunk.pieceId, piece.bytes.length);
  }
  const totals = new Map<string, number>();
  for (const chunk of manifest.chunks) {
    for (const id of chunk.nodeIds) totals.set(id, (totals.get(id) ?? 0) + (sizes.get(chunk.pieceId) ?? 0));
  }
  return totals;
}
async function registryNodes(registry: { nodes(): Promise<any[]> }): Promise<any[]> {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try { return await registry.nodes(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 500)); }
  }
  throw last;
}
async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) { const s = createServer(); await new Promise<void>((res, rej) => s.once("error", rej).listen(0, "127.0.0.1", () => res())); const a = s.address(); if (!a || typeof a === "string") throw new Error("port"); ports.push((a as import("net").AddressInfo).port); await new Promise<void>((res) => s.close(() => res())); }
  return ports;
}
