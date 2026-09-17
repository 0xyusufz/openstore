import { execFile, execFileSync } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { createConnection, createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../../packages/identity/index.js";
import { hashPieceId } from "../../packages/manifest/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { createOperationRecordStore, createPieceClaim, createClaimOnNode, releaseClaimOnNode, storeClaimedPieceOnNode } from "../../apps/client/provenance.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { deleteFile } from "../../apps/client/delete.js";
import { MixedStorageTransport } from "../../apps/client/http-transport.js";
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

suite("Milestone 050C Docker testnet", () => {
  it("replicates, fails over, persists, deletes, and cleans provenance safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-050c-"));
    const project = `openstore-050c-${process.pid}`;
    const envPath = join(root, ".env.testnet");
    const overridePath = join(root, "docker-compose.override.yml");
    const token = `050c-${process.pid}-${Date.now()}`;
    const ports = await reservePorts(4);
    const [coordinatorPort, node1Port, node2Port, node3Port] = ports;
    const env = [
      `OPENSTORE_COORDINATOR_TOKEN=${token}`,
      "OPENSTORE_NODE_1_PASSWORD=local-node-1-password",
      "OPENSTORE_NODE_2_PASSWORD=local-node-2-password",
      "OPENSTORE_NODE_3_PASSWORD=local-node-3-password",
      `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`,
      `OPENSTORE_NODE_1_HOST_PORT=${node1Port}`,
      `OPENSTORE_NODE_2_HOST_PORT=${node2Port}`,
      `OPENSTORE_NODE_3_HOST_PORT=${node3Port}`,
      "",
    ].join("\n");
    await writeFile(envPath, env, { mode: 0o600 });
    const scannerConfig = join(root, "scanner.json");
    await writeFile(scannerConfig, JSON.stringify({ orphanCleanup: { enabled: true, gracePeriodMs: 500, intervalMs: 200, batchSize: 100, maxDeletionsPerRun: 10 } }));
    await writeFile(overridePath, `
services:
  node-1:
    environment:
      OPENSTORE_NODE_CONFIG: /run/openstore/scanner.json
    volumes:
      - ${scannerConfig}:/run/openstore/scanner.json:ro
  node-2:
    environment:
      OPENSTORE_NODE_CONFIG: /run/openstore/scanner.json
    volumes:
      - ${scannerConfig}:/run/openstore/scanner.json:ro
  node-3:
    environment:
      OPENSTORE_NODE_CONFIG: /run/openstore/scanner.json
    volumes:
      - ${scannerConfig}:/run/openstore/scanner.json:ro
`);

    const compose = (...args: string[]) => run("docker", [
      "compose", "--project-name", project, "--env-file", envPath,
      "-f", "deploy/testnet/docker-compose.yml", "-f", overridePath, ...args,
    ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
    const status = async () => compose("ps", "--format", "json");
    const publishedPort = async (service: string, internalPort: number): Promise<number> => {
      const result = await compose("port", service, String(internalPort));
      const match = result.stdout.trim().match(/:(\d+)$/);
      if (!match) throw new Error(`could not determine published port for ${service}`);
      return Number(match[1]);
    };
    try {
      await compose("up", "-d", "--build");
      const publishedPorts = new Map([
        ["node-1", await publishedPort("node-1", 4101)],
        ["node-2", await publishedPort("node-2", 4102)],
        ["node-3", await publishedPort("node-3", 4103)],
      ]);
      const coordinatorUrl = `http://127.0.0.1:${await publishedPort("coordinator", 4190)}`;
      const registry = createRegistryClient({ baseUrl: coordinatorUrl, token });
      await waitFor(async () => (await registry.status()).status === "ok");
      const adapter = createCoordinatorAdapter({ baseUrl: coordinatorUrl, token });
      let endpoints = await waitForEndpoints(adapter, 3);
      const identities = new Set(endpoints.map((endpoint) => endpoint.id));
      expect(identities.size).toBe(3);

      const hostPorts = new Map(endpoints.map((endpoint) => [
        endpoint.id,
        endpoint.multiaddr?.includes("/node-1/") ? publishedPorts.get("node-1")! : endpoint.multiaddr?.includes("/node-2/") ? publishedPorts.get("node-2")! : publishedPorts.get("node-3")!,
      ] as const));
      const node2Id = endpoints.find((endpoint) => endpoint.multiaddr?.includes("/node-2/"))!.id;
      endpoints = endpoints.map((endpoint) => hostEndpoint(endpoint, hostPorts.get(endpoint.id)!));
      await waitFor(async () => Promise.all([...hostPorts.values()].map((port) => canConnect(port))).then((results) => results.every(Boolean)));
      const clientIdentity = createIdentity();
      const clientRoot = join(root, "client");
      const manifestStore = createManifestStore({ dir: join(clientRoot, "manifests") });
      const operationStore = createOperationRecordStore(join(clientRoot, "operations"));
      const plaintext = Buffer.from("050C encrypted Docker testnet payload");
      const uploaded = await uploadBuffer(plaintext, "050c.txt", endpoints, {
        replicationFactor: 3, manifestStore,
      });
      const pieceId = uploaded.manifest.chunks[0]!.pieceId;
      expect(uploaded.manifest.chunks[0]!.nodeIds).toHaveLength(3);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints)).toEqual(plaintext);

      const transport = new MixedStorageTransport();
      for (const endpoint of endpoints) {
        const piece = await transport.getPiece(toAddress(endpoint), pieceId, { timeoutMs: 10_000 });
        expect(piece.status).toBe(200);
        expect(piece.bytes).toBeDefined();
        expect(piece.bytes?.equals(plaintext)).toBe(false);
      }

      const stoppedId = node2Id;
      await compose("stop", "node-2");
      await waitFor(async () => {
        const stopped = (await registry.nodes()).find((node) => node.nodeId === stoppedId);
        return stopped === undefined || stopped.available === false;
      });
      await expect(downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints)).resolves.toEqual(plaintext);

      await compose("start", "node-2");
      await waitFor(async () => (await registry.nodes()).some((node) => node.nodeId === stoppedId && node.available));
      const afterNodeRestart = await waitForEndpoints(adapter, 3);
      expect(afterNodeRestart.map((endpoint) => endpoint.id)).toContain(stoppedId);
      const restartedEndpoint = hostEndpoint(afterNodeRestart.find((endpoint) => endpoint.id === stoppedId)!, publishedPorts.get("node-2")!);
      const persistedPiece = await transport.getPiece(toAddress(restartedEndpoint), pieceId, { timeoutMs: 10_000 });
      expect(persistedPiece.status).toBe(200);

      await deleteFile(uploaded.manifest, endpoints, { identity: clientIdentity, manifestStore, operationStore });
      for (const endpoint of endpoints) {
        expect((await transport.getPiece(toAddress(endpoint), pieceId, { timeoutMs: 10_000 })).status).toBe(404);
      }

      const orphanBytes = Buffer.from("050C opaque orphan candidate");
      const orphanId = hashPieceId(orphanBytes);
      const orphanClaim = createPieceClaim(orphanId, "upload", clientIdentity);
      const orphanEndpoint = hostEndpoint(afterNodeRestart[0]!, hostPorts.get(afterNodeRestart[0]!.id)!);
      await createClaimOnNode(orphanEndpoint, orphanClaim, clientIdentity, { timeoutMs: 10_000 });
      await storeClaimedPieceOnNode(orphanEndpoint, orphanId, orphanClaim.claimId, orphanBytes, clientIdentity, { timeoutMs: 10_000 });
      await releaseClaimOnNode(orphanEndpoint, orphanId, orphanClaim.claimId, clientIdentity, { timeoutMs: 10_000 });
      await waitFor(async () => (await transport.getPiece(toAddress(orphanEndpoint), orphanId, { timeoutMs: 10_000 })).status === 404, 20_000);

      const beforeCoordinatorRestart = new Set((await registry.nodes()).map((node) => node.nodeId));
      const restartStartedAt = Date.now();
      await compose("stop", "coordinator");
      await compose("start", "coordinator");
      if (process.env.OPENSTORE_DEBUG_DOCKER_TESTNET === "1") {
        const health = await compose("exec", "-T", "coordinator", "sh", "-c", "test -f /var/lib/openstore/coordinator/registry.json && echo exists || echo missing");
        console.error("050C restart file", Date.now() - restartStartedAt, health.stdout.trim());
      }
      await waitFor(async () => {
        const status = await registry.status();
        if (process.env.OPENSTORE_DEBUG_DOCKER_TESTNET === "1") console.error("050C restart status", Date.now() - restartStartedAt, JSON.stringify(status));
        return status.status === "ok";
      });
      await waitFor(async () => {
        const nodes = await registry.nodes();
        if (process.env.OPENSTORE_DEBUG_DOCKER_TESTNET === "1") console.error("050C restart nodes", Date.now() - restartStartedAt, JSON.stringify(nodes));
        return [...beforeCoordinatorRestart].every((nodeId) => nodes.some((node) => node.nodeId === nodeId));
      }, 20_000);
      const afterCoordinatorRestart = new Set((await registry.nodes()).map((node) => node.nodeId));
      expect([...beforeCoordinatorRestart].every((nodeId) => afterCoordinatorRestart.has(nodeId))).toBe(true);
      expect((await status()).stdout.length).toBeGreaterThan(0);
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);
});

function hostEndpoint(endpoint: StorageNodeEndpoint, port: number): StorageNodeEndpoint {
  if (!endpoint.multiaddr) throw new Error("libp2p endpoint missing multiaddr");
  return { ...endpoint, multiaddr: endpoint.multiaddr.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${port}`) };
}

function toAddress(endpoint: StorageNodeEndpoint) {
  return { nodeId: endpoint.id, baseUrl: endpoint.baseUrl, multiaddr: endpoint.multiaddr, identityBinding: endpoint.identityBinding, identity: endpoint.identity };
}

async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>, count: number): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await waitFor(async () => { endpoints = await adapter.refresh(); return endpoints.length === count; }, 30_000);
  return endpoints;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Services may still be starting or restarting; readiness checks retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Docker testnet readiness timeout");
}

async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to reserve test port");
    ports.push(address.port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return ports;
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}
