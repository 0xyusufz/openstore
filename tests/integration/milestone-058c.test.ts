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
import type { StorageNodeEndpoint } from "../../apps/client/index.js";
import { MixedStorageTransport } from "../../apps/client/http-transport.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";
import { encodeEncryptedPiece } from "../../packages/manifest/index.js";
import { encryptChunk, generateEncryptionKey } from "../../packages/crypto/index.js";

const run = promisify(execFile);
const dockerAvailable = (() => {
  try { execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const suite = dockerAvailable && process.env.OPENSTORE_RUN_DOCKER_TESTNET === "1" ? describe : describe.skip;
const CHUNK_SIZE = 4 * 1024 * 1024;

suite("Milestone 058C real capacity-exhaustion placement gate", () => {
  it("excludes an exhausted durable node while preserving honest placement", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-058c-"));
    const project = `openstore-058c-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env.testnet");
    const overridePath = join(root, "compose.override.yml");
    const [coordinatorPort, node1Port, node2Port, node3Port] = await reservePorts(4);
    const token = `058c-${process.pid}-${Date.now()}`;
    const passwords = ["058c-node-1-password", "058c-node-2-password", "058c-node-3-password"];
    await writeFile(envPath, [`OPENSTORE_COORDINATOR_TOKEN=${token}`, `OPENSTORE_NODE_1_PASSWORD=${passwords[0]}`, `OPENSTORE_NODE_2_PASSWORD=${passwords[1]}`, `OPENSTORE_NODE_3_PASSWORD=${passwords[2]}`, `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`, `OPENSTORE_NODE_1_HOST_PORT=${node1Port}`, `OPENSTORE_NODE_2_HOST_PORT=${node2Port}`, `OPENSTORE_NODE_3_HOST_PORT=${node3Port}`, ""].join("\n"), { mode: 0o600 });
    await writeFile(overridePath, ["services:", "  node-1:", "    environment:", "      OPENSTORE_NODE_CAPACITY_BYTES: \"10485760\"", "      OPENSTORE_NODE_ALLOCATION_PATH: /var/lib/openstore/pieces/allocation.json", "  node-2:", "    environment:", "      OPENSTORE_NODE_CAPACITY_BYTES: \"33554432\"", "      OPENSTORE_NODE_ALLOCATION_PATH: /var/lib/openstore/pieces/allocation.json", "  node-3:", "    environment:", "      OPENSTORE_NODE_CAPACITY_BYTES: \"50331648\"", "      OPENSTORE_NODE_ALLOCATION_PATH: /var/lib/openstore/pieces/allocation.json", ""].join("\n"), { mode: 0o600 });
    const compose = (...args: string[]) => run("docker", ["compose", "--project-name", project, "--env-file", envPath, "-f", "deploy/testnet/docker-compose.yml", "-f", overridePath, ...args], { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    const baseUrl = `http://127.0.0.1:${coordinatorPort}`;
    const registry = createRegistryClient({ baseUrl, token });
    const adapter = createCoordinatorAdapter({ baseUrl, token });
    const ports = new Map([["node-1", node1Port], ["node-2", node2Port], ["node-3", node3Port]]);
    const transport = new MixedStorageTransport();
    const plaintext = Buffer.alloc(CHUNK_SIZE + 257, 0x5a);
    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => (await registry.status()).status === "ok");
      let endpoints = await waitForEndpoints(adapter);
      const byService = new Map(endpoints.map((endpoint) => [nodeService(endpoint), endpoint]));
      expect(byService.size).toBe(3);
      expect([...byService.values()].every((endpoint) => endpoint.capacity?.allocatedBytes !== undefined && endpoint.capacity.availableBytes > 0 && endpoint.capacity.usedBytes >= 0 && endpoint.id.length > 0)).toBe(true);
      endpoints = endpoints.map((endpoint) => hostEndpoint(endpoint, ports.get(nodeService(endpoint))!));
      const expectedPieceSize = encodeEncryptedPiece(encryptChunk(Buffer.alloc(CHUNK_SIZE), generateEncryptionKey())).length;
      expect(expectedPieceSize).toBeGreaterThan(0);
      const first = await uploadBuffer(plaintext, "058c-large.bin", endpoints, { chunkSize: CHUNK_SIZE, replicationFactor: 3, transport });
      expect(first.manifest.totalChunks).toBe(2);
      expect(first.manifest.chunks.every((chunk) => chunk.nodeIds.length === 3 && new Set(chunk.nodeIds).size === 3)).toBe(true);
      expect(await downloadBuffer(first.manifest, first.encryptionKey, endpoints, { transport })).toEqual(plaintext);
      const before = await adapter.refresh();
      const exhaustedBefore = before.find((node) => node.id === byService.get("node-1")?.id)!;
      if (!exhaustedBefore?.capacity) throw new Error("exhaustion target did not report capacity");
      expect(exhaustedBefore.capacity.allocatedBytes).toBe(10_485_760);
      expect(exhaustedBefore.capacity.usedBytes).toBeGreaterThan(0);
      expect(exhaustedBefore.capacity.availableBytes).toBeLessThan(expectedPieceSize);
      const secondData = Buffer.from("058C second encrypted placement");
      const second = await uploadBuffer(secondData, "058c-follow-up.bin", endpoints, { chunkSize: CHUNK_SIZE, replicationFactor: 2, transport });
      expect(second.manifest.chunks[0]?.nodeIds).toHaveLength(2);
      expect(second.manifest.chunks[0]?.nodeIds).not.toContain(exhaustedBefore.id);
      expect(await downloadBuffer(second.manifest, second.encryptionKey, endpoints, { transport })).toEqual(secondData);
      const after = await adapter.refresh();
      const exhaustedAfter = after.find((node) => node.id === exhaustedBefore.id)!;
      if (!exhaustedAfter?.capacity) throw new Error("exhaustion target disappeared after upload");
      expect(exhaustedAfter.capacity).toMatchObject({ allocatedBytes: exhaustedBefore.capacity.allocatedBytes, usedBytes: exhaustedBefore.capacity.usedBytes });
      expect(exhaustedAfter.capacity.availableBytes).toBeLessThan(expectedPieceSize);
      expect(second.manifest.chunks.every((chunk) => chunk.nodeIds.length === 2 && new Set(chunk.nodeIds).size === 2)).toBe(true);
      await expect(uploadBuffer(Buffer.alloc(CHUNK_SIZE), "058c-impossible.bin", endpoints, { chunkSize: CHUNK_SIZE, replicationFactor: 3, transport })).rejects.toThrow(/insufficient|replication/i);
      const logs = await compose("logs", "--no-log-prefix");
      for (const secret of [token, ...passwords, plaintext.toString("utf8")]) { expect(logs.stdout).not.toContain(secret); expect(logs.stderr).not.toContain(secret); }
      expect(JSON.stringify(after)).not.toMatch(/privateKey|password|token|plaintext|\/var\/lib/i);
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 420_000);
});

function nodeService(endpoint: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  if (endpoint.multiaddr?.includes("/node-1/")) return "node-1";
  if (endpoint.multiaddr?.includes("/node-2/")) return "node-2";
  if (endpoint.multiaddr?.includes("/node-3/")) return "node-3";
  throw new Error("unknown testnet node");
}
function hostEndpoint(endpoint: StorageNodeEndpoint, port: number): StorageNodeEndpoint {
  if (!endpoint.multiaddr) throw new Error("missing node multiaddr");
  return { ...endpoint, multiaddr: endpoint.multiaddr.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${port}`) };
}
async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await waitFor(async () => { endpoints = await adapter.refresh(); return endpoints.length === 3; });
  return endpoints;
}
async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 300)); }
  throw new Error("058C testnet readiness timeout");
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
