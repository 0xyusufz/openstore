import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { MixedStorageTransport } from "../../apps/client/http-transport.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";
import type { P2PNodeAddress, P2PStoreResult, P2PTransport, P2PTransportRequestOptions } from "../../packages/p2p/index.js";
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

suite("Milestone 057B encrypted upload and replication", () => {
  it("uploads encrypted multi-chunk content to all three nodes and downloads it exactly", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-057b-"));
    const project = `openstore-057b-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env.testnet");
    const [coordinatorPort, node1Port, node2Port, node3Port] = await reservePorts(4);
    const token = `057b-${process.pid}-${Date.now()}`;
    const marker = Buffer.from(`057B-PLAINTEXT-MARKER-${process.pid}-${Date.now()}`);
    const plaintext = Buffer.alloc(5 * 1024 * 1024 + 137);
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

    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => (await registry.status()).status === "ok");
      const adapter = createCoordinatorAdapter({ baseUrl: coordinatorUrl, token });
      let endpoints = await waitForEndpoints(adapter, 3);
      const publishedPorts = new Map([
        ["node-1", node1Port],
        ["node-2", node2Port],
        ["node-3", node3Port],
      ]);
      endpoints = endpoints.map((endpoint) => hostEndpoint(endpoint, publishedPorts.get(nodeService(endpoint))!));
      const transport = new RecordingTransport(new MixedStorageTransport());

      const uploaded = await uploadBuffer(plaintext, "057b-large.bin", endpoints, {
        chunkSize: 4 * 1024 * 1024,
        replicationFactor: 3,
        transport,
      });

      expect(uploaded.manifest.size).toBe(plaintext.length);
      expect(uploaded.manifest.chunkSize).toBe(4 * 1024 * 1024);
      expect(uploaded.manifest.totalChunks).toBe(2);
      expect(uploaded.manifest.chunks).toHaveLength(2);
      for (const chunk of uploaded.manifest.chunks) {
        expect(chunk.nodeIds).toHaveLength(3);
        expect(new Set(chunk.nodeIds).size).toBe(3);
      }
      expect(new Set(uploaded.manifest.nodeIds)).toEqual(new Set(endpoints.map((endpoint) => endpoint.id)));
      expect(transport.stored.length).toBe(6);
      expect(transport.stored.every(({ data }) => !data.includes(marker))).toBe(true);
      const keyBytes = Buffer.from(uploaded.encryptionKey);
      expect(transport.stored.every(({ data }) => !data.includes(keyBytes))).toBe(true);

      for (const endpoint of endpoints) {
        for (const chunk of uploaded.manifest.chunks) {
          const piece = await transport.getPiece(toAddress(endpoint), chunk.pieceId, { timeoutMs: 15_000 });
          expect(piece.status).toBe(200);
          expect(piece.bytes).toBeDefined();
          expect(piece.bytes?.includes(marker)).toBe(false);
          expect(piece.bytes?.includes(keyBytes)).toBe(false);
        }
      }
      const downloaded = await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport });
      expect(downloaded.equals(plaintext)).toBe(true);

      const logs = await compose("logs", "--no-log-prefix");
      expect(logs.stdout).not.toContain(marker.toString("utf8"));
      expect(logs.stderr).not.toContain(marker.toString("utf8"));
      expect(logs.stdout).not.toContain(keyBytes.toString("base64"));
      expect(logs.stderr).not.toContain(keyBytes.toString("base64"));
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});

class RecordingTransport implements P2PTransport {
  readonly protocol = "recording";
  readonly stored: Array<{ node: string; pieceId: string; data: Buffer }> = [];

  constructor(private readonly delegate: P2PTransport) {}

  async storePiece(node: P2PNodeAddress, pieceId: string, data: Buffer, options: P2PTransportRequestOptions): Promise<P2PStoreResult> {
    this.stored.push({ node: node.nodeId, pieceId, data: Buffer.from(data) });
    return this.delegate.storePiece(node, pieceId, data, options);
  }
  getPiece(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions) {
    return this.delegate.getPiece(node, pieceId, options);
  }
  deletePiece(node: P2PNodeAddress, pieceId: string, options: P2PTransportRequestOptions) {
    return this.delegate.deletePiece(node, pieceId, options);
  }
  health(node: P2PNodeAddress, options: P2PTransportRequestOptions) {
    return this.delegate.health(node, options);
  }
}

function nodeService(endpoint: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  if (endpoint.multiaddr?.includes("/node-1/")) return "node-1";
  if (endpoint.multiaddr?.includes("/node-2/")) return "node-2";
  if (endpoint.multiaddr?.includes("/node-3/")) return "node-3";
  throw new Error("endpoint is missing its testnet node identity");
}

function hostEndpoint(endpoint: StorageNodeEndpoint, port: number): StorageNodeEndpoint {
  if (!endpoint.multiaddr) throw new Error("libp2p endpoint missing multiaddr");
  return { ...endpoint, multiaddr: endpoint.multiaddr.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${port}`) };
}

function toAddress(endpoint: StorageNodeEndpoint): P2PNodeAddress {
  return {
    nodeId: endpoint.id,
    baseUrl: endpoint.baseUrl,
    multiaddr: endpoint.multiaddr,
    identityBinding: endpoint.identityBinding,
    identity: endpoint.identity,
  };
}

async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>, count: number): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await waitFor(async () => { endpoints = await adapter.refresh(); return endpoints.length === count; });
  return endpoints;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Services may still be starting; readiness checks retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("057B testnet readiness timeout");
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
