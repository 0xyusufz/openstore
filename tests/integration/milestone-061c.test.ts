import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { createRepairScheduler } from "../../apps/client/repair-scheduler.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { MixedStorageTransport } from "../../apps/client/http-transport.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";

const run = promisify(execFile);
const dockerAvailable = (() => {
  try { execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const suite = dockerAvailable && process.env.OPENSTORE_RUN_DOCKER_TESTNET === "1" ? describe : describe.skip;

suite("Milestone 061C bounded scheduler recovery", () => {
  it("fails boundedly for an ineligible target, then repairs after recovery", async () => {
    const root = await mkdtemp(join(process.cwd(), ".milestone-061c-"));
    const project = `openstore-061c-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env");
    const overridePath = join(root, "override.yml");
    const [coordinatorPort, node1Port, node2Port, node3Port] = await reservePorts(4);
    const token = `061c-${process.pid}-${Date.now()}`;
    await writeFile(envPath, [
      `OPENSTORE_COORDINATOR_TOKEN=${token}`,
      "OPENSTORE_NODE_1_PASSWORD=local-node-1-password", "OPENSTORE_NODE_2_PASSWORD=local-node-2-password", "OPENSTORE_NODE_3_PASSWORD=local-node-3-password",
      `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`, `OPENSTORE_NODE_1_HOST_PORT=${node1Port}`,
      `OPENSTORE_NODE_2_HOST_PORT=${node2Port}`, `OPENSTORE_NODE_3_HOST_PORT=${node3Port}`, "",
    ].join("\n"), { mode: 0o600 });
    const configFiles = await Promise.all(["node-1", "node-2", "node-3"].map(async (service) => {
      const path = join(root, `${service}.json`);
      await writeFile(path, JSON.stringify({ lifecyclePath: "/var/lib/openstore/pieces/.provider-lifecycle.json" }));
      return path;
    }));
    await writeFile(overridePath, [
      "services:",
      ...(["node-1", "node-2", "node-3"] as const).flatMap((service, index) => [
        `  ${service}:`, "    environment:", "      OPENSTORE_NODE_CONFIG: /etc/openstore/node-config.json",
        "      OPENSTORE_NODE_ALLOCATION_PATH: /var/lib/openstore/pieces/.capacity-allocation.json",
        "      OPENSTORE_NODE_CAPACITY_BYTES: \"67108864\"", "    mem_limit: 768m",
        "    volumes:", `      - "${configFiles[index]}:/etc/openstore/node-config.json:ro"`,
      ]), "",
    ].join("\n"));
    const compose = (...args: string[]) => run("docker", [
      "compose", "--project-name", project, "--env-file", envPath, "-f", "deploy/testnet/docker-compose.yml", "-f", overridePath, ...args,
    ], { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    const registry = createRegistryClient({ baseUrl: `http://127.0.0.1:${coordinatorPort}`, token });
    const adapter = createCoordinatorAdapter({ baseUrl: `http://127.0.0.1:${coordinatorPort}`, token });
    const manifests = createManifestStore({ dir: join(root, "manifests") });
    const transport = new MixedStorageTransport();
    const ports = new Map([["node-1", node1Port], ["node-2", node2Port], ["node-3", node3Port]]);
    const lifecycle = new Map<string, "sharing" | "draining">();
    const host = (endpoint: StorageNodeEndpoint): StorageNodeEndpoint => ({
      ...endpoint,
      multiaddr: endpoint.multiaddr?.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${ports.get(serviceFor(endpoint))}`),
      ...(lifecycle.get(endpoint.id) ? { lifecycle: lifecycle.get(endpoint.id) } : {}),
    });
    const coordinator = {
      refresh: async () => (await adapter.refresh()).map(host).filter((endpoint) => endpoint.lifecycle !== "draining"),
      getEndpoints: () => adapter.getEndpoints().map(host).filter((endpoint) => endpoint.lifecycle !== "draining"),
      getKnownEndpoints: () => adapter.getKnownEndpoints().map(host),
      get discovery() { return adapter.discovery; },
    };
    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => (await registry.status()).status === "ok");
      let endpoints = await waitForEndpoints(adapter);
      endpoints = endpoints.map(host);
      const uploaded = await uploadBuffer(Buffer.from("061C scheduler integration plaintext"), "061c.bin", endpoints, {
        replicationFactor: 2, manifestStore: manifests,
      });
      const lost = endpoints[0];
      await compose("kill", serviceFor(lost));
      await waitFor(async () => (await registry.nodes()).filter((node) => node.available).length === 2);
      const targetEndpoints = endpoints.filter((endpoint) => endpoint.id !== lost.id);
      const targetServices = targetEndpoints.map(serviceFor);
      for (const [index, service] of targetServices.entries()) {
        await setLifecycle(compose, service, "draining", root);
        lifecycle.set(targetEndpoints[index].id, "draining");
      }
      const before = JSON.stringify(await manifests.load(uploaded.manifest.fileId));
      let repairCalls = 0;
      const scheduler = createRepairScheduler({
        manifestStore: manifests, coordinator,
        options: {
          maxRetryRounds: 1, retryBackoffMs: 0, repairOptions: { observationCount: 1, retryAttempts: 1, transport },
          onEvent: () => { repairCalls += 1; },
        },
      });
      await scheduler.runOnce();
      await scheduler.runOnce();
      expect(JSON.stringify(await manifests.load(uploaded.manifest.fileId))).toBe(before);
      expect(Object.keys(scheduler.status.failedCounts).length).toBeGreaterThan(0);
      for (const [index, service] of targetServices.entries()) {
        await setLifecycle(compose, service, "sharing", root);
        lifecycle.set(targetEndpoints[index].id, "sharing");
      }
      await scheduler.runOnce();
      await scheduler.runOnce();
      const repaired = await manifests.load(uploaded.manifest.fileId);
      expect(new Set(repaired?.chunks[0].nodeIds).size).toBe(repaired?.chunks[0].nodeIds.length);
      expect(await downloadBuffer(repaired!, uploaded.encryptionKey, endpoints, { transport })).toEqual(Buffer.from("061C scheduler integration plaintext"));
      expect(repairCalls).toBeGreaterThan(0);
      expect(JSON.stringify(scheduler.status)).not.toMatch(/plaintext|dek|private|token|password/i);
      scheduler.stop();
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 420_000);
});

function serviceFor(endpoint: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  const address = endpoint.multiaddr ?? "";
  if (address.includes("4101")) return "node-1";
  if (address.includes("4102")) return "node-2";
  return "node-3";
}

async function setLifecycle(compose: (...args: string[]) => Promise<{ stdout: string }>, service: string, state: string, root: string): Promise<void> {
  const file = join(root, `${service}-${state}.json`);
  await writeFile(file, JSON.stringify({ version: 1, state, updatedAt: Date.now() }) + "\n");
  const { stdout } = await compose("ps", "-aq", service);
  await compose("stop", service);
  await run("docker", ["cp", file, `${stdout.trim()}:/var/lib/openstore/pieces/.provider-lifecycle.json`]);
  await compose("start", service);
}

async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await waitFor(async () => { endpoints = await adapter.refresh(); return endpoints.length === 3; });
  return endpoints;
}

async function waitFor(check: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 300)); }
  throw new Error("061C integration timeout");
}

async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("port reservation failed");
    ports.push(address.port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return ports;
}
