import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { repairManifestReplica, RepairError } from "../../apps/client/repair.js";
import { createRepairScheduler } from "../../apps/client/repair-scheduler.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { MixedStorageTransport } from "../../apps/client/http-transport.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import type { P2PNodeAddress } from "../../packages/p2p/index.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";

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

suite("Milestone 057C node failure, restart, and repair", () => {
  it("survives abrupt node loss and restores the durable 3/3 replica set after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-057c-"));
    const project = `openstore-057c-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env.testnet");
    const [coordinatorPort, node1Port, node2Port, node3Port] = await reservePorts(4);
    const token = `057c-${process.pid}-${Date.now()}`;
    const marker = Buffer.from(`057C-PLAINTEXT-MARKER-${process.pid}-${Date.now()}`);
    const plaintext = Buffer.alloc(5 * 1024 * 1024 + 257);
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
    const registryUrl = `http://127.0.0.1:${coordinatorPort}`;
    const registry = createRegistryClient({ baseUrl: registryUrl, token });
    const manifests = createManifestStore({ dir: join(root, "manifests") });
    const transport = new MixedStorageTransport();

    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => (await registry.status()).status === "ok");
      const adapter = createCoordinatorAdapter({ baseUrl: registryUrl, token });
      const publishedPorts: Map<"node-1" | "node-2" | "node-3", number> = new Map([
        ["node-1", node1Port],
        ["node-2", node2Port],
        ["node-3", node3Port],
      ]);
      const discoveredEndpoints = await waitForEndpoints(adapter, publishedPorts);
      const lostRaw = discoveredEndpoints[1];
      if (!lostRaw) throw new Error("three-node discovery incomplete");
      const lostService = nodeService(lostRaw);
      let endpoints = discoveredEndpoints.map((endpoint) => hostEndpoint(endpoint, publishedPorts.get(nodeService(endpoint))!));
      const uploaded = await uploadBuffer(plaintext, "057c-large.bin", endpoints, {
        chunkSize: 4 * 1024 * 1024,
        replicationFactor: 3,
        manifestStore: manifests,
      });
      expect(uploaded.manifest.chunkSize).toBe(4 * 1024 * 1024);
      expect(uploaded.manifest.totalChunks).toBe(2);
      for (const chunk of uploaded.manifest.chunks) expect(new Set(chunk.nodeIds).size).toBe(3);

      const lostNode = endpoints.find((endpoint) => endpoint.id === lostRaw.id);
      if (!lostNode) throw new Error("lost node endpoint mapping failed");
      await compose("kill", lostService);
      await waitFor(async () => {
        const nodes = await registry.nodes();
        return nodes.filter((node) => node.available).length === 2 &&
          !nodes.some((node) => node.nodeId === lostNode.id && node.available);
      }, 30_000);

      const surviving = endpoints.filter((endpoint) => endpoint.id !== lostNode.id);
      expect((await registry.nodes()).filter((node) => node.available)).toHaveLength(2);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, surviving, { transport })).toEqual(plaintext);

      await expect(repairManifestReplica(uploaded.manifest.fileId, {
        manifestStore: manifests,
        coordinator: adapter,
        lostNodeId: lostNode.id,
        observationCount: 1,
        transport,
      })).rejects.toSatisfy((error: unknown) =>
        error instanceof RepairError &&
        ["coordinator-stale", "coordinator-unavailable", "target-unavailable"].includes(error.classification),
      );

      const scheduler = createRepairScheduler({
        manifestStore: manifests,
        coordinator: adapter,
        options: { intervalMs: 100, repairOptions: { transport } },
      });
      await scheduler.runOnce();
      expect(JSON.stringify(scheduler.status)).not.toMatch(/private|secret|plaintext|DEK|token/i);
      expect(Object.keys(scheduler.status.failedCounts).length).toBeLessThanOrEqual(6);

      await compose("start", lostService);
      await waitFor(async () => (await registry.nodes()).some((node) => node.nodeId === lostNode.id && node.available), 45_000);
      const recovered = await waitForEndpoints(adapter, publishedPorts);
      const recoveredNode = recovered.find((endpoint) => endpoint.id === lostNode.id);
      if (!recoveredNode) throw new Error("restarted node did not re-register");
      const recoveredEndpoint = hostEndpoint(recoveredNode, publishedPorts.get(lostService)!);

      const afterRecovery = createRepairScheduler({
        manifestStore: manifests,
        coordinator: adapter,
        options: { intervalMs: 100, repairOptions: { transport } },
      });
      await afterRecovery.runOnce();
      const persisted = await Promise.all(uploaded.manifest.chunks.map((chunk) =>
        transport.getPiece(toAddress(recoveredEndpoint), chunk.pieceId, { timeoutMs: 15_000 })));
      expect(persisted.every((piece) => piece.status === 200)).toBe(true);

      const finalManifest = await manifests.load(uploaded.manifest.fileId);
      expect(finalManifest).toBeDefined();
      for (const chunk of finalManifest!.chunks) {
        expect(chunk.nodeIds).toHaveLength(3);
        expect(new Set(chunk.nodeIds).size).toBe(3);
        expect(chunk.nodeIds).toContain(lostNode.id);
      }
      expect(await downloadBuffer(finalManifest!, uploaded.encryptionKey, recovered.map((endpoint) =>
        hostEndpoint(endpoint, publishedPorts.get(nodeService(endpoint))!), { transport })).then((value) => value.equals(plaintext))).toBe(true);

      const logs = await compose("logs", "--no-log-prefix");
      expect(logs.stdout).not.toContain(marker.toString("utf8"));
      expect(logs.stderr).not.toContain(marker.toString("utf8"));
      expect(logs.stdout).not.toContain(Buffer.from(uploaded.encryptionKey).toString("base64"));
      expect(logs.stderr).not.toContain(Buffer.from(uploaded.encryptionKey).toString("base64"));
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 360_000);
});

function nodeService(endpoint: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  if (endpoint.multiaddr?.includes("/node-1/")) return "node-1";
  if (endpoint.multiaddr?.includes("/node-2/")) return "node-2";
  if (endpoint.multiaddr?.includes("/node-3/")) return "node-3";
  if (endpoint.multiaddr?.includes("/tcp/4101/")) return "node-1";
  if (endpoint.multiaddr?.includes("/tcp/4102/")) return "node-2";
  if (endpoint.multiaddr?.includes("/tcp/4103/")) return "node-3";
  throw new Error("endpoint is missing its testnet node identity");
}

function hostEndpoint(endpoint: StorageNodeEndpoint, port: number): StorageNodeEndpoint {
  if (!endpoint.multiaddr) throw new Error("libp2p endpoint missing multiaddr");
  return { ...endpoint, multiaddr: endpoint.multiaddr.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${port}`) };
}

function toAddress(endpoint: StorageNodeEndpoint): P2PNodeAddress {
  return { nodeId: endpoint.id, baseUrl: endpoint.baseUrl, multiaddr: endpoint.multiaddr, identityBinding: endpoint.identityBinding, identity: endpoint.identity };
}

async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>, ports: Map<"node-1" | "node-2" | "node-3", number>): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await waitFor(async () => {
    const discovered = await adapter.refresh();
    endpoints = discovered.filter((endpoint) => {
      try {
        const service = nodeService(endpoint);
        return endpoint.multiaddr?.includes(`/tcp/${ports.get(service)}/`) === true ||
          endpoint.multiaddr?.includes(`/tcp/${service === "node-1" ? 4101 : service === "node-2" ? 4102 : 4103}/`) === true ||
          endpoint.multiaddr?.includes(`/dns4/${service}/`) === true;
      } catch {
        return false;
      }
    });
    return new Set(endpoints.map((endpoint) => nodeService(endpoint)).values()).size === 3;
  }, 45_000);
  return endpoints;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Services may still be starting or reconnecting; readiness checks retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("057C testnet readiness timeout");
}

async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to reserve test port");
    ports.push(address.port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return ports;
}
