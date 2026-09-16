import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { createRegistryClient, type RegistryClient } from "../../packages/registry/coordinator.js";
import { createStorageNode, type StorageNode } from "../../apps/storage-node/index.js";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { deleteFile } from "../../apps/client/delete.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";

const PASSWORD = "milestone-044-test-password";
const TOKEN = "milestone-044-test-token";

describe("Milestone 044 cross-process integration", () => {
  it("replicates, expires, fails over, restarts, and supports mixed placement", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-044-"));
    const processes: ChildProcess[] = [];
    let httpNode: StorageNode | undefined;
    try {
      const coordinatorProcess = spawn(process.execPath, [
        "--import", "tsx", "apps/registry/coordinator-cli.ts",
        "--port", "0", "--heartbeat-timeout-ms", "2000", "--token-env", "OPENSTORE_044_TOKEN",
      ], childOptions());
      processes.push(coordinatorProcess);
      const coordinatorOutput = await waitForJson(coordinatorProcess, (value) => value.event === "started");
      const coordinatorUrl = String(coordinatorOutput.url);
      const registryClient = createRegistryClient({ baseUrl: coordinatorUrl, token: TOKEN });

      const nodes = await Promise.all([
        launchNode(root, "a", coordinatorUrl, processes),
        launchNode(root, "b", coordinatorUrl, processes),
      ]);
      await waitForNodeCount(registryClient, 2);

      const adapter = createCoordinatorAdapter({ baseUrl: coordinatorUrl, token: TOKEN });
      const discovered = await waitForEndpoints(adapter, 2);
      const libp2p = discovered.filter((endpoint) => endpoint.transport === "libp2p");
      expect(libp2p).toHaveLength(2);
      expect(new Set(libp2p.map((endpoint) => endpoint.id)).size).toBe(2);

      const plaintext = Buffer.from("Milestone 044 replicated content");
      const uploaded = await uploadBuffer(plaintext, "milestone-044.txt", [], {
        coordinator: adapter,
        replicationFactor: 2,
      });
      const chunk = uploaded.manifest.chunks[0];
      expect(chunk.nodeIds).toHaveLength(2);
      expect(new Set(chunk.nodeIds).size).toBe(2);

      const storedPiece = await readFile(join(root, "a", "pieces", chunk.pieceId));
      const storedPieceB = await readFile(join(root, "b", "pieces", chunk.pieceId));
      expect(storedPiece).toEqual(storedPieceB);
      expect(storedPiece).not.toEqual(plaintext);

      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, [], {
        coordinator: adapter,
      })).toEqual(plaintext);
      expect(uploaded.manifest.chunks[0].nodeIds).toEqual(chunk.nodeIds);

      nodes[1].process.kill("SIGKILL");
      await waitForNodeUnavailable(registryClient, nodes[1].peerId);

      const surviving = await waitForEndpoints(adapter, 1);
      expect(surviving).toHaveLength(1);
      expect(surviving[0].id).toBe(nodes[0].peerId);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, [], {
        coordinator: adapter,
        retryAttempts: 1,
      })).toEqual(plaintext);
      expect(uploaded.manifest.chunks[0].nodeIds).toEqual(chunk.nodeIds);

      const restarted = await launchNode(root, "b", coordinatorUrl, processes);
      expect(restarted.peerId).toBe(nodes[1].peerId);
      await waitForNodeCount(registryClient, 2);
      const afterRestart = await waitForEndpoints(adapter, 2);
      expect(afterRestart.map((endpoint) => endpoint.id)).toContain(nodes[1].peerId);
      expect(await stat(join(root, "b", "pieces", chunk.pieceId))).toBeTruthy();
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, [], {
        coordinator: adapter,
      })).toEqual(plaintext);

      httpNode = createStorageNode({
        storageDir: join(root, "http", "pieces"),
        identity: createIdentity(),
        requireAuth: true,
        capacityBytes: 1024 * 1024,
      });
      const httpPort = await httpNode.listen(0);
      const httpIdentity = httpNode.identity;
      if (!httpIdentity) throw new Error("HTTP test node identity was not initialized");
      const httpRecord = await registryClient.registerWithIdentity(
        httpIdentity,
        `http://127.0.0.1:${httpPort}`,
        { allocatedBytes: 1024 * 1024, usedBytes: 0, availableBytes: 1024 * 1024 },
      );
      const httpEndpoint: StorageNodeEndpoint = {
        id: httpRecord.nodeId,
        baseUrl: httpRecord.baseUrl,
        transport: "http",
        identity: { publicKey: httpIdentity.publicKey.toString("base64") },
        capacity: httpRecord.capacity,
      };
      const mixedLibp2p = afterRestart.find((endpoint) => endpoint.transport === "libp2p");
      if (!mixedLibp2p) throw new Error("no libp2p endpoint available for mixed placement");
      const mixed = await uploadBuffer(Buffer.from("mixed transport content"), "mixed.txt", [
        httpEndpoint,
        mixedLibp2p,
      ], {
        replicationFactor: 2,
        identity: httpIdentity,
      });
      expect(mixed.manifest.chunks[0].nodeIds).toEqual([httpEndpoint.id, mixedLibp2p.id]);
      expect(await downloadBuffer(mixed.manifest, mixed.encryptionKey, [
        httpEndpoint,
        mixedLibp2p,
      ], { identity: httpIdentity })).toEqual(Buffer.from("mixed transport content"));
      await deleteFile(mixed.manifest, [httpEndpoint, mixedLibp2p], { identity: httpIdentity });
    } finally {
      if (httpNode) await httpNode.close().catch(() => undefined);
      await Promise.all(processes.reverse().map((child) => stopChild(child)));
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

function childOptions(): SpawnOptions {
  return {
    cwd: process.cwd(),
    env: { ...process.env, OPENSTORE_044_TOKEN: TOKEN, OPENSTORE_044_PASSWORD: PASSWORD },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
}

async function launchNode(
  root: string,
  name: string,
  coordinatorUrl: string,
  processes: ChildProcess[],
): Promise<{ peerId: string; listenAddr: string; process: ChildProcess }> {
  const identity = createIdentity();
  const nodeRoot = join(root, name);
  const identityPath = join(nodeRoot, "identity.json");
  await mkdir(nodeRoot, { recursive: true });
  try {
    await access(identityPath);
  } catch {
    await saveIdentity(identity, PASSWORD, identityPath);
  }
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/storage-node/libp2p-cli.ts",
    "--storage-dir", join(nodeRoot, "pieces"),
    "--identity", identityPath,
    "--password-env", "OPENSTORE_044_PASSWORD",
    "--listen", "/ip4/127.0.0.1/tcp/0",
    "--capacity-bytes", "1048576",
    "--max-piece-bytes", "65536",
    "--coordinator-url", coordinatorUrl,
    "--coordinator-token-env", "OPENSTORE_044_TOKEN",
    "--heartbeat-interval-ms", "500",
  ], childOptions());
  processes.push(child);
  const output = await waitForJson(child, (value) => value.event === "started");
  return { peerId: String(output.peerId), listenAddr: String((output.listenAddrs as string[])[0]), process: child };
}

async function waitForJson(
  child: ChildProcess,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("child readiness timed out")), 20_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (predicate(value)) {
            clearTimeout(timer);
            child.stdout?.off("data", onData);
            resolve(value);
            return;
          }
        } catch {
          // Ignore non-JSON diagnostics; readiness requires a valid event.
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", () => undefined);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`child exited before readiness: ${code}`));
      }
    });
  });
}

async function waitForNodeCount(client: RegistryClient, count: number): Promise<void> {
  await poll(async () => (await client.nodes()).filter((node) => node.available).length === count);
}

async function waitForNodeUnavailable(client: RegistryClient, nodeId: string): Promise<void> {
  await poll(async () => (await client.nodes()).some((node) => node.nodeId === nodeId && node.available === false));
}

async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>, count: number): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await poll(async () => {
    endpoints = await adapter.refreshSafe();
    return endpoints.length === count;
  });
  return endpoints;
}

async function poll(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("bounded readiness/expiry polling timed out");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}