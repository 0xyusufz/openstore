import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
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

suite("Milestone 061B failure-repair resilience integration", () => {
  it("repairs around failure while excluding draining, released, and exhausted targets", async () => {
    const root = await mkdtemp(join(process.cwd(), ".milestone-061b-"));
    const project = `openstore-061b-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env.testnet");
    const overridePath = join(root, "compose.override.yml");
    const [coordinatorPort, node1Port, node2Port, node3Port] = await reservePorts(4);
    const token = `061b-${process.pid}-${Date.now()}`;
    const marker = Buffer.from(`061B-PLAINTEXT-MARKER-${process.pid}-${Date.now()}`);
    const plaintext = Buffer.alloc(5 * 1024 * 1024 + 173);
    for (let offset = 0; offset < plaintext.length; offset += marker.length) marker.copy(plaintext, offset, 0, Math.min(marker.length, plaintext.length - offset));
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
        `  ${service}:`,
        "    environment:",
        "      NODE_OPTIONS: --max-old-space-size=384",
        "      OPENSTORE_NODE_CONFIG: /etc/openstore/node-config.json",
        "      OPENSTORE_NODE_ALLOCATION_PATH: /var/lib/openstore/pieces/.capacity-allocation.json",
        "      OPENSTORE_NODE_CAPACITY_BYTES: \"67108864\"",
        "    mem_limit: 768m",
        "    volumes:",
        `      - "${configFiles[index]}:/etc/openstore/node-config.json:ro"`,
      ]),
      "",
    ].join("\n"));
    const compose = (...args: string[]) => run("docker", [
      "compose", "--project-name", project, "--env-file", envPath,
      "-f", "deploy/testnet/docker-compose.yml", "-f", overridePath, ...args,
    ], { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    const baseUrl = `http://127.0.0.1:${coordinatorPort}`;
    const registry = createRegistryClient({ baseUrl, token });
    const adapter = createCoordinatorAdapter({ baseUrl, token });
    const manifests = createManifestStore({ dir: join(root, "manifests") });
    const transport = new MixedStorageTransport();
    const ports = new Map<"node-1" | "node-2" | "node-3", number>([["node-1", node1Port], ["node-2", node2Port], ["node-3", node3Port]]);
    const lifecycleOverrides = new Map<string, "draining" | "released" | "sharing">();
    const hostForRepair = (endpoint: StorageNodeEndpoint): StorageNodeEndpoint => ({
      ...hostEndpoint(endpoint, ports.get(nodeService(endpoint))!),
      ...(lifecycleOverrides.get(nodeService(endpoint)) ? { lifecycle: lifecycleOverrides.get(nodeService(endpoint)) } : {}),
    });
    const repairCoordinator = {
      refresh: async () => (await adapter.refresh()).map(hostForRepair).filter((endpoint) => lifecycleOverrides.get(nodeService(endpoint)) !== "draining" && lifecycleOverrides.get(nodeService(endpoint)) !== "released"),
      getEndpoints: () => adapter.getEndpoints().map(hostForRepair).filter((endpoint) => lifecycleOverrides.get(nodeService(endpoint)) !== "draining" && lifecycleOverrides.get(nodeService(endpoint)) !== "released"),
      getKnownEndpoints: () => adapter.getKnownEndpoints().map(hostForRepair),
      get discovery() { return adapter.discovery; },
    };

    try {
      await compose("up", "-d", "coordinator");
      await compose("up", "-d", "node-1");
      await compose("up", "-d", "node-2");
      await compose("up", "-d", "node-3");
      await compose("start", "node-1").catch(() => undefined);
      await waitFor(async () => (await registry.status()).status === "ok");
      let endpoints = (await waitForEndpoints(adapter)).map((endpoint) => hostEndpoint(endpoint, ports.get(nodeService(endpoint))!));
      const uploaded = await uploadBuffer(plaintext, "061b-large.bin", endpoints, {
        chunkSize: 4 * 1024 * 1024, replicationFactor: 3, manifestStore: manifests,
      });
      expect(uploaded.manifest.chunks).toHaveLength(2);
      expect(uploaded.manifest.chunks.every((chunk) => chunk.nodeIds.length === 3)).toBe(true);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);
      expect(JSON.stringify(uploaded.manifest)).not.toContain(marker.toString());
      for (const endpoint of endpoints) for (const chunk of uploaded.manifest.chunks) {
        const piece = await transport.getPiece(toAddress(endpoint), chunk.pieceId, { timeoutMs: 15_000 });
        if (piece.bytes) expect(piece.bytes.includes(marker)).toBe(false);
      }

      // Three nodes are fully occupied by the RF=3 file; use a second RF=2
      // object to exercise replacement-target recovery without inventing a
      // fourth provider.
      const repairable = await uploadBuffer(plaintext, "061b-repairable.bin", endpoints, {
        chunkSize: 4 * 1024 * 1024, replicationFactor: 2, manifestStore: manifests,
      });
      const lost = endpoints.find((endpoint) => nodeService(endpoint) !== "node-3" &&
        repairable.manifest.chunks.every((chunk) => chunk.nodeIds.includes(endpoint.id)));
      if (!lost) throw new Error("no non-target node was selected for every uploaded chunk");
      const lostService = nodeService(lost);
      const repairTarget = endpoints.find((endpoint) =>
        endpoint.id !== lost.id && repairable.manifest.chunks.every((chunk) => !chunk.nodeIds.includes(endpoint.id)));
      if (!repairTarget) throw new Error("no unused sharing repair target was available");
      const drainedService = nodeService(endpoints.find((endpoint) =>
        endpoint.id !== lost.id && endpoint.id !== repairTarget.id)!);
      await compose("kill", lostService);
      await waitFor(async () => (await registry.nodes()).filter((node) => node.available).length === 2);

      await setLifecycle(compose, project, drainedService, "draining", root);
      lifecycleOverrides.set(drainedService, "draining");
      await waitFor(async () => (await registry.nodes()).find((node) => node.nodeId === endpoints.find((e) => nodeService(e) === drainedService)?.id)?.lifecycle === "draining");
      const drainedRepair = await retryRepair(() => repairManifestReplica(repairable.manifest.fileId, {
        manifestStore: manifests, coordinator: repairCoordinator, lostNodeId: lost.id, observationCount: 1, transport,
      }));
      expect(drainedRepair.chunks.every((chunk) => chunk.addedNodeId !== endpoints.find((e) => nodeService(e) === drainedService)?.id)).toBe(true);

      await setLifecycle(compose, project, drainedService, "sharing", root);
      lifecycleOverrides.set(drainedService, "sharing");
      endpoints = (await adapter.refresh()).map((endpoint) => hostEndpoint(endpoint, ports.get(nodeService(endpoint))!));
      await expect(downloadBuffer(drainedRepair.manifest, repairable.encryptionKey, endpoints, { transport })).resolves.toEqual(plaintext);

      // The failed node must be back and visible before requiring a complete
      // three-node coordinator snapshot.
      await compose("start", lostService);
      await waitFor(async () => (await registry.nodes()).filter((node) => node.available).length === 3);
      endpoints = (await waitForEndpoints(adapter)).map((endpoint) => hostEndpoint(endpoint, ports.get(nodeService(endpoint))!));
      expect(new Set(endpoints.map((endpoint) => endpoint.id)).size).toBe(3);

      // A coordinator restart must not change node identities or make the
      // repaired manifest unreadable.
      await compose("stop", "coordinator");
      await waitFor(async () => {
        try { await registry.status(); return false; } catch { return true; }
      }, 30_000);
      await compose("start", "coordinator");
      await waitFor(async () => {
        try { return (await registry.status()).status === "ok"; } catch { return false; }
      });
      endpoints = (await waitForEndpoints(adapter)).map((endpoint) => hostEndpoint(endpoint, ports.get(nodeService(endpoint))!));
      expect(new Set(endpoints.map((endpoint) => endpoint.id)).size).toBe(3);
      await expect(downloadBuffer(drainedRepair.manifest, repairable.encryptionKey, endpoints, { transport })).resolves.toEqual(plaintext);

      const secondLost = endpoints.find((endpoint) => nodeService(endpoint) !== drainedService && endpoint.id !== lost.id)!;
      const beforeManifest = JSON.stringify(await manifests.load(repairable.manifest.fileId));
      await compose("kill", nodeService(secondLost));
      await waitFor(async () => (await registry.nodes()).filter((node) => node.available).length === 2);

      // Two simultaneous losses are explicitly degraded: with no surviving
      // source replica, repair must fail safely and leave the manifest intact.
      const degradedPeer = endpoints.find((endpoint) =>
        endpoint.id !== secondLost.id &&
        drainedRepair.manifest.chunks.every((chunk) => chunk.nodeIds.includes(endpoint.id)));
      if (!degradedPeer) throw new Error("no second manifest replica was available for degraded test");
      await compose("kill", nodeService(degradedPeer));
      await waitFor(async () => (await registry.nodes()).filter((node) => node.available).length === 1);
      await expect(repairManifestReplica(repairable.manifest.fileId, {
        manifestStore: manifests, coordinator: repairCoordinator, lostNodeId: secondLost.id, observationCount: 1, transport,
      })).rejects.toSatisfy((error: unknown) => error instanceof RepairError &&
        error.classification === "source-unavailable");
      expect(JSON.stringify(await manifests.load(repairable.manifest.fileId))).toBe(beforeManifest);
      await compose("start", nodeService(degradedPeer));
      await waitFor(async () => (await registry.nodes()).filter((node) => node.available).length === 2);

      const status = await registry.nodes();
      const target = status.find((node) => node.nodeId === endpoints.find((e) => nodeService(e) === lostService)?.id)!;
      await setCapacity(compose, lostService, target.capacity.usedBytes, Math.max(target.capacity.usableBytes ?? 1, target.capacity.allocatedBytes ?? 1), root);
      endpoints = (await adapter.refresh()).map((endpoint) => hostEndpoint(endpoint, ports.get(nodeService(endpoint))!));
      await expect(repairManifestReplica(repairable.manifest.fileId, {
        manifestStore: manifests, coordinator: repairCoordinator, lostNodeId: secondLost.id, observationCount: 1, transport,
      })).rejects.toSatisfy((error: unknown) => error instanceof RepairError &&
        (error.classification === "insufficient-capacity" || error.classification === "target-unavailable"));
      expect(JSON.stringify(await manifests.load(repairable.manifest.fileId))).toBe(beforeManifest);
      const persisted = await manifests.load(repairable.manifest.fileId);
      expect(persisted?.chunks.every((chunk) => chunk.nodeIds.length === new Set(chunk.nodeIds).size)).toBe(true);

      // The coordinator-facing lifecycle override models a released target without
      // deleting the manifest's last known source replica.
      lifecycleOverrides.set(lostService, "released");
      await expect(repairManifestReplica(repairable.manifest.fileId, {
        manifestStore: manifests, coordinator: repairCoordinator, lostNodeId: secondLost.id, observationCount: 1, transport,
      })).rejects.toSatisfy((error: unknown) => error instanceof RepairError && error.classification === "target-unavailable");
      expect(JSON.stringify(await manifests.load(repairable.manifest.fileId))).toBe(beforeManifest);
      const logs = await compose("logs", "--no-log-prefix");
      for (const secret of [marker.toString(), token, Buffer.from(uploaded.encryptionKey).toString("base64"), Buffer.from(repairable.encryptionKey).toString("base64")]) {
        expect(logs.stdout).not.toContain(secret);
        expect(logs.stderr).not.toContain(secret);
      }
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 420_000);
});

async function setLifecycle(compose: (...args: string[]) => Promise<{ stdout: string }>, project: string, service: string, state: string, root: string): Promise<void> {
  const file = join(root, `${service}-${state}.json`);
  await writeFile(file, JSON.stringify({ version: 1, state, updatedAt: Date.now() }) + "\n", { mode: 0o600 });
  const { stdout } = await compose("ps", "-q", service);
  const container = stdout.trim();
  if (!container) throw new Error(`missing ${service} container`);
  await compose("stop", service);
  await run("docker", ["cp", file, `${container}:/var/lib/openstore/pieces/.provider-lifecycle.json`]);
  await compose("start", service);
}

async function setCapacity(compose: (...args: string[]) => Promise<{ stdout: string }>, service: string, usedBytes: number, filesystemBytes: number, root: string): Promise<void> {
  const file = join(root, `${service}-capacity.json`);
  const allocationBytes = Math.max(usedBytes, 1024 * 1024);
  await writeFile(file, JSON.stringify({ version: 1, allocationBytes, usedBytes, reservedBytes: 0, physicalBytes: filesystemBytes, usableBytes: filesystemBytes, availableBytes: allocationBytes - usedBytes }) + "\n");
  const { stdout } = await compose("ps", "-q", service);
  await compose("stop", service);
  await run("docker", ["cp", file, `${stdout.trim()}:/var/lib/openstore/pieces/.capacity-allocation.json`]);
  await compose("start", service);
}

function nodeService(endpoint: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  const known = serviceById.get(endpoint.id);
  if (known) return known;
  if (endpoint.multiaddr?.includes("/node-1/") || endpoint.multiaddr?.includes("/tcp/4101/")) return "node-1";
  if (endpoint.multiaddr?.includes("/node-2/") || endpoint.multiaddr?.includes("/tcp/4102/")) return "node-2";
  if (endpoint.multiaddr?.includes("/node-3/") || endpoint.multiaddr?.includes("/tcp/4103/")) return "node-3";
  throw new Error("unknown node service");
}
const serviceById = new Map<string, "node-1" | "node-2" | "node-3">();
function hostEndpoint(endpoint: StorageNodeEndpoint, port: number): StorageNodeEndpoint {
  if (!endpoint.multiaddr) throw new Error("missing node multiaddr");
  const service = endpoint.multiaddr.includes("/node-1/") || endpoint.multiaddr.includes("/tcp/4101/") ? "node-1" :
    endpoint.multiaddr.includes("/node-2/") || endpoint.multiaddr.includes("/tcp/4102/") ? "node-2" : "node-3";
  serviceById.set(endpoint.id, service);
  return { ...endpoint, multiaddr: endpoint.multiaddr.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${port}`) };
}
function toAddress(endpoint: StorageNodeEndpoint) {
  return { nodeId: endpoint.id, baseUrl: endpoint.baseUrl, multiaddr: endpoint.multiaddr, identityBinding: endpoint.identityBinding, identity: endpoint.identity };
}
async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>) {
  let endpoints: StorageNodeEndpoint[] = [];
  await waitFor(async () => { endpoints = await adapter.refresh(); return endpoints.length === 3; });
  return endpoints;
}
async function waitFor(check: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 300)); }
  throw new Error("061B readiness timeout");
}

async function retryRepair<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await operation(); } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError;
}
async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("port reservation failed");
    ports.push(address.port); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return ports;
}
