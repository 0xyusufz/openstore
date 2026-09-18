import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createConnection, createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { repairManifestReplica, RepairError } from "../../apps/client/repair.js";
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

suite("Milestone 057E final real testnet integration gate", () => {
  it("completes encrypted upload, node failure/restart, coordinator restart, and final placement", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-057e-"));
    const project = `openstore-057e-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env.testnet");
    const [coordinatorPort, node1Port, node2Port, node3Port] = await reservePorts(4);
    const token = `057e-${process.pid}-${Date.now()}`;
    const marker = Buffer.from(`057E-PLAINTEXT-${process.pid}-${Date.now()}`);
    const plaintext = Buffer.alloc(5 * 1024 * 1024 + 513);
    for (let offset = 0; offset < plaintext.length; offset += marker.length) marker.copy(plaintext, offset, 0, Math.min(marker.length, plaintext.length - offset));
    await writeFile(envPath, [
      `OPENSTORE_COORDINATOR_TOKEN=${token}`, "OPENSTORE_NODE_1_PASSWORD=node-1-password",
      "OPENSTORE_NODE_2_PASSWORD=node-2-password", "OPENSTORE_NODE_3_PASSWORD=node-3-password",
      `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`, `OPENSTORE_NODE_1_HOST_PORT=${node1Port}`,
      `OPENSTORE_NODE_2_HOST_PORT=${node2Port}`, `OPENSTORE_NODE_3_HOST_PORT=${node3Port}`, "",
    ].join("\n"), { mode: 0o600 });
    const compose = (...args: string[]) => run("docker", [
      "compose", "--project-name", project, "--env-file", envPath, "-f", "deploy/testnet/docker-compose.yml", ...args,
    ], { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    const baseUrl = `http://127.0.0.1:${coordinatorPort}`;
    const registry = createRegistryClient({ baseUrl, token });
    const adapter = createCoordinatorAdapter({ baseUrl, token });
    const manifests = createManifestStore({ dir: join(root, "manifests") });
    const transport = new MixedStorageTransport();
    const ports: Map<"node-1" | "node-2" | "node-3", number> = new Map([["node-1", node1Port], ["node-2", node2Port], ["node-3", node3Port]]);
    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => {
        try { const r = await fetch(`${baseUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` } }); return r.ok; } catch { return false; }
      });
      const serviceById = new Map<string, "node-1" | "node-2" | "node-3">();
      for (const service of ["node-1", "node-2", "node-3"] as const) {
        const peerId = await waitForPeerId(compose, service);
        serviceById.set(peerId, service);
      }
      let endpoints = await waitForEndpoints(adapter, ports);
      const ids = endpoints.map((e) => e.id).sort();
      endpoints = endpoints.map((e) => hostEndpoint(e, ports.get(serviceById.get(e.id)!)!));
      const first = await uploadBuffer(plaintext, "057e-large.bin", endpoints, { chunkSize: 4 * 1024 * 1024, replicationFactor: 3, manifestStore: manifests });
      expect(first.manifest.chunkSize).toBe(4 * 1024 * 1024);
      expect(first.manifest.totalChunks).toBeGreaterThanOrEqual(2);
      expect(first.manifest.chunks.every((c) => c.nodeIds.length === 3 && new Set(c.nodeIds).size === 3)).toBe(true);
      expect(await downloadBuffer(first.manifest, first.encryptionKey, endpoints, { transport })).toEqual(plaintext);

      const lost = endpoints[1]!;
      const lostService = serviceById.get(lost.id)!;
      await compose("kill", lostService);
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 2);
      const survivors = endpoints.filter((e) => e.id !== lost.id);
      expect(await downloadBuffer(first.manifest, first.encryptionKey, survivors, { transport })).toEqual(plaintext);
      await expect(repairManifestReplica(first.manifest.fileId, { manifestStore: manifests, coordinator: adapter, lostNodeId: lost.id, observationCount: 1, transport }))
        .rejects.toSatisfy((e: unknown) => e instanceof RepairError);

      await compose("start", lostService);
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 3);
      endpoints = (await waitForEndpoints(adapter, ports)).map((e) => hostEndpoint(e, ports.get(serviceById.get(e.id)!)!));
      expect(endpoints.map((e) => e.id).sort()).toEqual(ids);
      expect(await downloadBuffer(first.manifest, first.encryptionKey, endpoints, { transport })).toEqual(plaintext);

      await compose("stop", "coordinator");
      await waitFor(async () => !(await canConnect(coordinatorPort)));
      expect(await canConnect(node1Port)).toBe(true);
      expect(await canConnect(node2Port)).toBe(true);
      expect(await canConnect(node3Port)).toBe(true);
      let freshFailed = false;
      try { await adapter.refresh(); } catch { freshFailed = true; }
      expect(freshFailed).toBe(true);
      expect(await downloadBuffer(first.manifest, first.encryptionKey, endpoints, { transport })).toEqual(plaintext);

      await compose("start", "coordinator");
      await waitFor(async () => {
        try { const r = await fetch(`${baseUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` } }); return r.ok && (await r.json() as { status?: string }).status === "ok"; } catch { return false; }
      });
      await waitFor(async () => (await registry.nodes()).filter((n) => n.available).length === 3, 60_000);
      endpoints = (await waitForEndpoints(adapter, ports)).map((e) => hostEndpoint(e, ports.get(serviceById.get(e.id)!)!));
      expect(endpoints.map((e) => e.id).sort()).toEqual(ids);

      const secondData = Buffer.from("057E post-restart encrypted placement");
      const second = await uploadBuffer(secondData, "057e-small.bin", endpoints, { chunkSize: 4 * 1024 * 1024, replicationFactor: 3, manifestStore: manifests });
      expect(second.manifest.chunks[0]?.nodeIds).toHaveLength(3);
      await expect(downloadBuffer(second.manifest, second.encryptionKey, endpoints, { transport })).resolves.toEqual(secondData);
      const persisted = await manifests.load(first.manifest.fileId);
      expect(persisted?.chunks.every((c) => c.nodeIds.length === 3 && new Set(c.nodeIds).size === 3)).toBe(true);
      const logs = await compose("logs", "--no-log-prefix");
      for (const value of [marker.toString(), Buffer.from(first.encryptionKey).toString("base64"), token]) {
        expect(logs.stdout).not.toContain(value); expect(logs.stderr).not.toContain(value);
      }
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 420_000);
});

function nodeService(e: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  if (e.multiaddr?.includes("/node-1/") || e.multiaddr?.includes("/tcp/4101/")) return "node-1";
  if (e.multiaddr?.includes("/node-2/") || e.multiaddr?.includes("/tcp/4102/")) return "node-2";
  if (e.multiaddr?.includes("/node-3/") || e.multiaddr?.includes("/tcp/4103/")) return "node-3";
  throw new Error("unknown testnet node identity");
}
function hostEndpoint(e: StorageNodeEndpoint, port: number): StorageNodeEndpoint {
  if (!e.multiaddr) throw new Error("missing node multiaddr");
  return { ...e, multiaddr: e.multiaddr.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${port}`) };
}
async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>, ports: Map<"node-1" | "node-2" | "node-3", number>) {
  let result: StorageNodeEndpoint[] = [];
  await waitFor(async () => {
    const discovered = await adapter.refresh();
    result = discovered;
    return result.length === 3;
  });
  return result;
}
async function waitForPeerId(compose: (...args: string[]) => Promise<{ stdout: string }>, service: "node-1" | "node-2" | "node-3") {
  let peerId = "";
  await waitFor(async () => {
    try {
      const output = await compose("logs", "--no-log-prefix", service);
      const match = output.stdout.match(/"peerId":"([^"]+)"/);
      if (match) { peerId = match[1]!; return true; }
    } catch {}
    return false;
  });
  return peerId;
}
async function waitFor(check: () => Promise<boolean>, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  throw new Error("057E readiness timeout");
}
async function canConnect(port: number) {
  return new Promise<boolean>((resolve) => { const s = createConnection({ host: "127.0.0.1", port }); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("error", () => { s.destroy(); resolve(false); }); });
}
async function reservePorts(count: number) {
  const result: number[] = [];
  for (let i = 0; i < count; i++) { const s = createServer(); await new Promise<void>((r, j) => { s.once("error", j); s.listen(0, "127.0.0.1", r); }); const a = s.address(); if (!a || typeof a === "string") throw new Error("port reservation failed"); result.push(a.port); await new Promise<void>((r) => s.close(() => r())); }
  return result;
}
