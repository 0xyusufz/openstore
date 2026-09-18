import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { repairManifestReplica } from "../../apps/client/repair.js";
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

// Milestone 067: adversarial storage nodes over the real Docker testnet.
// A live node is turned dishonest by overwriting its stored piece bytes
// (garbage, then another valid piece's bytes). The client must detect the
// corruption before acceptance, serve from surviving replicas, and repair
// must re-replicate boundedly without duplicates or manifest corruption.
// A node disappearing mid-scenario must never yield partial files.
suite("Milestone 067 adversarial nodes over Docker testnet", () => {
  it("corrupt/wrong-piece bytes are rejected, survivors serve, repair re-replicates", async () => {
    const root = await mkdtemp(join(process.cwd(), ".milestone-067-"));
    const project = `openstore-067-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env");
    const overridePath = join(root, "override.yml");
    const [coordinatorPort, n1Port, n2Port, n3Port] = await reservePorts(4);
    const token = `067-${process.pid}-${Date.now()}`;
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
    const baseUrl = `http://127.0.0.1:${coordinatorPort}`;
    const registry = createRegistryClient({ baseUrl, token });
    const adapter = createCoordinatorAdapter({ baseUrl, token });
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

      // Two chunks so the wrong-piece attack has a distinct donor piece.
      const plaintext = Buffer.alloc(4 * 1024 * 1024 + 257);
      const marker = Buffer.from("067-adversarial-plaintext");
      for (let o = 0; o < plaintext.length; o += marker.length) marker.copy(plaintext, o);
      const uploaded = await uploadBuffer(plaintext, "067-adv.bin", endpoints, {
        chunkSize: 4 * 1024 * 1024, replicationFactor: 2, manifestStore: manifests,
      });
      expect(uploaded.manifest.chunks).toHaveLength(2);
      const pieceId = uploaded.manifest.chunks[0]!.pieceId;
      const holders = endpoints.filter((e) => uploaded.manifest.chunks[0]!.nodeIds.includes(e.id));
      expect(holders).toHaveLength(2);
      const dishonest = holders[0]!;
      const dishonestSvc = serviceFor(dishonest);

      // Attack 1: overwrite stored bytes with garbage. Download must skip
      // the corrupt replica (hash mismatch) and serve from the survivor.
      await exec(dishonestSvc, "sh", "-c", `head -c 2048 /dev/urandom > /var/lib/openstore/pieces/${pieceId}`);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);

      // Attack 2: overwrite with a *different valid piece's* bytes (wrong
      // piece ID). Same outcome: detected before acceptance, survivor serves.
      const otherPiece = uploaded.manifest.chunks[1]!.pieceId;
      expect(otherPiece).not.toBe(pieceId);
      await exec(dishonestSvc, "sh", "-c",
        `cp /var/lib/openstore/pieces/${otherPiece} /var/lib/openstore/pieces/${pieceId}`);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);

      // Attack 3: dishonest node disappears mid-scenario. No partial files:
      // the survivor still serves the complete file.
      // Stop (not kill) so Docker does not auto-restart it mid-repair.
      await compose("stop", dishonestSvc);
      await waitFor(async () => (await registryNodes(registry)).filter((n) => n.available).length === 2);
      await waitFor(async () => { try { const eps = await hostAware.refresh(); return eps.length === 2; } catch { return false; } });
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport, retryAttempts: 2 })).toEqual(plaintext);

      // Repair re-replicates the corrupted replica away while the liar is
      // genuinely unavailable: bounded and duplicate-free, and the manifest
      // never references the liar again.
      const repaired = await retryRepair(() => repairManifestReplica(uploaded.manifest.fileId, {
        manifestStore: manifests, coordinator: hostAware, lostNodeId: dishonest.id,
        observationCount: 1, transport,
      }));
      expect(repaired.chunks.length).toBeGreaterThan(0);
      await compose("start", dishonestSvc);
      await waitFor(async () => (await registryNodes(registry)).filter((n) => n.available).length === 3);
      endpoints = (await waitForEndpoints(adapter)).map(host);
      await waitFor(async () => { try { const eps = await hostAware.refresh(); return eps.length === 3; } catch { return false; } });
      const final = await manifests.load(uploaded.manifest.fileId);
      expect(final!.chunks[0]!.nodeIds).not.toContain(dishonest.id);
      expect(new Set(final!.chunks[0]!.nodeIds).size).toBe(2);
      expect(await downloadBuffer(final!, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);
      expect(JSON.stringify(final)).not.toContain(marker.toString());

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
async function registryNodes(registry: { nodes(): Promise<any[]> }): Promise<any[]> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      return await registry.nodes();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}
async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>): Promise<StorageNodeEndpoint[]> {
  let eps: StorageNodeEndpoint[] = [];
  await waitFor(async () => { eps = await adapter.refresh(); return eps.length === 3; });
  return eps;
}
async function waitFor(check: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  throw new Error("067 readiness timeout");
}
async function retryRepair<T>(op: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) { try { return await op(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1000)); } }
  throw last;
}
async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) { const s = createServer(); await new Promise<void>((res, rej) => s.once("error", rej).listen(0, "127.0.0.1", () => res())); const a = s.address(); if (!a || typeof a === "string") throw new Error("port"); ports.push((a as import("net").AddressInfo).port); await new Promise<void>((res) => s.close(() => res())); }
  return ports;
}
