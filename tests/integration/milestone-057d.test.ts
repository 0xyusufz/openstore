import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createConnection, createServer } from "net";
import { tmpdir } from "os";
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
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const suite = dockerAvailable && process.env.OPENSTORE_RUN_DOCKER_TESTNET === "1" ? describe : describe.skip;

suite("Milestone 057D coordinator restart and resilience", () => {
  it("preserves durable registry state, fails closed during outage, and recovers all nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-057d-"));
    const project = `openstore-057d-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env.testnet");
    const [coordinatorPort, node1Port, node2Port, node3Port] = await reservePorts(4);
    const token = `057d-${process.pid}-${Date.now()}`;
    const marker = Buffer.from(`057D-PLAINTEXT-MARKER-${process.pid}-${Date.now()}`);
    const plaintext = Buffer.alloc(5 * 1024 * 1024 + 331);
    for (let offset = 0; offset < plaintext.length; offset += marker.length) {
      marker.copy(plaintext, offset, 0, Math.min(marker.length, plaintext.length - offset));
    }
    await writeFile(envPath, [
      `OPENSTORE_COORDINATOR_TOKEN=${token}`,
      "OPENSTORE_NODE_1_PASSWORD=local-node-1-password",
      "OPENSTORE_NODE_2_PASSWORD=local-node-2-password",
      "OPENSTORE_NODE_3_PASSWORD=local-node-3-password",
      `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`,
      `OPENSTORE_NODE_1_HOST_PORT=${node1Port}`,
      `OPENSTORE_NODE_2_HOST_PORT=${node2Port}`,
      `OPENSTORE_NODE_3_HOST_PORT=${node3Port}`,
      "",
    ].join("\n"), { mode: 0o600 });

    const compose = (...args: string[]) => run("docker", [
      "compose", "--project-name", project, "--env-file", envPath,
      "-f", "deploy/testnet/docker-compose.yml", ...args,
    ], { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    const coordinatorUrl = `http://127.0.0.1:${coordinatorPort}`;
    const registry = createRegistryClient({ baseUrl: coordinatorUrl, token });
    const adapter = createCoordinatorAdapter({ baseUrl: coordinatorUrl, token });
    const manifestStore = createManifestStore({ dir: join(root, "manifests") });
    const transport = new MixedStorageTransport();

    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => {
        try {
          const response = await fetch(`${coordinatorUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
          return response.ok && (await response.json() as { status?: string }).status === "ok";
        } catch { return false; }
      });
      const publishedPorts: Map<"node-1" | "node-2" | "node-3", number> = new Map([
        ["node-1", node1Port], ["node-2", node2Port], ["node-3", node3Port],
      ]);
      const initial = await waitForEndpoints(adapter, publishedPorts);
      const initialIds = initial.map((endpoint) => endpoint.id).sort();
      const endpoints = initial.map((endpoint) => hostEndpoint(endpoint, publishedPorts.get(nodeService(endpoint))!));
      const uploaded = await uploadBuffer(plaintext, "057d-large.bin", endpoints, {
        chunkSize: 4 * 1024 * 1024, replicationFactor: 3, manifestStore,
      });
      expect(uploaded.manifest.chunkSize).toBe(4 * 1024 * 1024);
      expect(uploaded.manifest.chunks).toHaveLength(2);
      expect(uploaded.manifest.chunks.every((chunk) => chunk.nodeIds.length === 3 && new Set(chunk.nodeIds).size === 3)).toBe(true);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);

      const beforeResponse = await fetch(`${coordinatorUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
      const before = await beforeResponse.json() as { persistence: { healthy: boolean } };
      expect(before.persistence.healthy).toBe(true);
      const beforeNodes = await registry.nodes();
      expect(beforeNodes.filter((node) => node.available)).toHaveLength(3);

      await compose("stop", "coordinator");
      await waitFor(async () => !(await canConnect(coordinatorPort)));
      expect(await canConnect(node1Port)).toBe(true);
      expect(await canConnect(node2Port)).toBe(true);
      expect(await canConnect(node3Port)).toBe(true);
      expect(await canConnect(coordinatorPort)).toBe(false);
      let placementRejected = false;
      try {
        await adapter.refresh();
      } catch (error) {
        placementRejected = error instanceof Error;
      }
      expect(placementRejected).toBe(true);
      await expect(downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).resolves.toEqual(plaintext);

      await compose("start", "coordinator");
      let after: { status: string; persistence: { healthy: boolean; degraded: boolean } } | undefined;
      await waitFor(async () => {
        try {
          const response = await fetch(`${coordinatorUrl}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
          if (!response.ok) return false;
          const candidate = await response.json() as typeof after;
          if (candidate?.status !== "ok") return false;
          after = candidate;
          return true;
        } catch {
          return false;
        }
      });
      if (!after) throw new Error("coordinator did not become ready after restart");
      expect(after.persistence.healthy).toBe(true);
      expect(after.persistence.degraded).toBe(false);
      const recovered = await waitForEndpoints(adapter, publishedPorts);
      expect(recovered.map((endpoint) => endpoint.id).sort()).toEqual(initialIds);
      const recoveredNodes = await registry.nodes();
      expect(recoveredNodes.filter((node) => node.available)).toHaveLength(3);
      expect(JSON.stringify(after)).not.toMatch(/private|secret|plaintext|DEK|token/i);

      const recoveredEndpoints = recovered.map((endpoint) => hostEndpoint(endpoint, publishedPorts.get(nodeService(endpoint))!));
      await expect(downloadBuffer(uploaded.manifest, uploaded.encryptionKey, recoveredEndpoints, { transport })).resolves.toEqual(plaintext);
      const persisted = await manifestStore.load(uploaded.manifest.fileId);
      expect(persisted?.chunks.every((chunk) => chunk.nodeIds.length === 3 && new Set(chunk.nodeIds).size === 3)).toBe(true);

      const postRestart = await uploadBuffer(Buffer.from("057D post-restart encrypted placement"), "057d-small.bin", recoveredEndpoints, {
        chunkSize: 4 * 1024 * 1024, replicationFactor: 3, manifestStore,
      });
      expect(postRestart.manifest.chunkSize).toBe(4 * 1024 * 1024);
      expect(postRestart.manifest.chunks[0]?.nodeIds).toHaveLength(3);
      await expect(downloadBuffer(postRestart.manifest, postRestart.encryptionKey, recoveredEndpoints, { transport })).resolves.toEqual(Buffer.from("057D post-restart encrypted placement"));

      const logs = await compose("logs", "--no-log-prefix");
      expect(logs.stdout).not.toContain(marker.toString("utf8"));
      expect(logs.stderr).not.toContain(marker.toString("utf8"));
      expect(logs.stdout).not.toContain(Buffer.from(uploaded.encryptionKey).toString("base64"));
      expect(logs.stderr).not.toContain(Buffer.from(uploaded.encryptionKey).toString("base64"));
      expect(logs.stdout).not.toContain(token);
      expect(logs.stderr).not.toContain(token);
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);
});

function nodeService(endpoint: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  if (endpoint.multiaddr?.includes("/node-1/") || endpoint.multiaddr?.includes("/tcp/4101/")) return "node-1";
  if (endpoint.multiaddr?.includes("/node-2/") || endpoint.multiaddr?.includes("/tcp/4102/")) return "node-2";
  if (endpoint.multiaddr?.includes("/node-3/") || endpoint.multiaddr?.includes("/tcp/4103/")) return "node-3";
  throw new Error("endpoint missing testnet service identity");
}

function hostEndpoint(endpoint: StorageNodeEndpoint, port: number): StorageNodeEndpoint {
  if (!endpoint.multiaddr) throw new Error("libp2p endpoint missing multiaddr");
  return { ...endpoint, multiaddr: endpoint.multiaddr.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${port}`) };
}

async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>, ports: Map<"node-1" | "node-2" | "node-3", number>): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await waitFor(async () => {
    const discovered = await adapter.refresh();
    endpoints = discovered.filter((endpoint) => {
      try { return Boolean(ports.get(nodeService(endpoint))); } catch { return false; }
    });
    return new Set(endpoints.map((endpoint) => nodeService(endpoint))).size === 3;
  }, 45_000);
  return endpoints;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* startup/restart is transient */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("057D readiness timeout");
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to reserve test port");
    ports.push(address.port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return ports;
}
