import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { repairManifestReplica } from "../../apps/client/repair.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";

const PASSWORD = "milestone-048b-password";
const TOKEN = "milestone-048b-token";

describe("Milestone 048B automatic repair", () => {
  it("repairs A+B to A+C after confirmed process loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-048b-"));
    const children: ChildProcess[] = [];
    try {
      const coordinator = await startCoordinator(children);
      const registry = createRegistryClient({ baseUrl: coordinator.url, token: TOKEN });
      const nodes = await Promise.all([
        startNode(root, "a", coordinator.url, children),
        startNode(root, "b", coordinator.url, children),
        startNode(root, "c", coordinator.url, children),
      ]);
      await poll(async () => (await registry.nodes()).filter((node) => node.available).length === 3);

      const adapter = createCoordinatorAdapter({ baseUrl: coordinator.url, token: TOKEN });
      const discovered = await waitForEndpoints(adapter, 3);
      const a = discovered.find((endpoint) => endpoint.id === nodes[0].peerId);
      const b = discovered.find((endpoint) => endpoint.id === nodes[1].peerId);
      if (!a || !b) throw new Error("initial replicas were not discovered");
      const store = createManifestStore({ dir: join(root, "client-manifests") });
      const original = Buffer.from("048B opaque repair integration");
      const uploaded = await uploadBuffer(original, "048b.txt", [a, b], {
        replicationFactor: 2,
        manifestStore: store,
      });
      const pieceId = uploaded.manifest.chunks[0].pieceId;
      const beforeA = await readFile(join(root, "a", "pieces", pieceId));
      const beforeB = await readFile(join(root, "b", "pieces", pieceId));
      expect(beforeA).toEqual(beforeB);
      expect(beforeA).not.toEqual(original);

      nodes[1].process.kill("SIGKILL");
      await poll(async () => (await registry.nodes()).some((node) => node.nodeId === nodes[1].peerId && !node.available));

      const repaired = await repairManifestReplica(uploaded.manifest.fileId, {
        manifestStore: store,
        coordinator: adapter,
        lostNodeId: nodes[1].peerId,
        observationCount: 2,
        observationIntervalMs: 100,
        gracePeriodMs: 100,
        retryAttempts: 1,
      });
      expect(repaired.manifest.chunks[0].nodeIds).toEqual([nodes[0].peerId, nodes[2].peerId]);
      const afterC = await readFile(join(root, "c", "pieces", pieceId));
      expect(afterC).toEqual(beforeA);
      expect(await downloadBuffer(repaired.manifest, uploaded.encryptionKey, [], { coordinator: adapter }))
        .toEqual(original);
      expect(JSON.stringify(repaired.manifest)).not.toContain(PASSWORD);
      expect(JSON.stringify(repaired.manifest)).not.toContain(TOKEN);
    } finally {
      await Promise.all(children.reverse().map((child) => stopChild(child)));
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

function spawnOptions(): SpawnOptions {
  return {
    cwd: process.cwd(),
    env: { ...process.env, OPENSTORE_048B_TOKEN: TOKEN, OPENSTORE_048B_PASSWORD: PASSWORD },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
}

async function startCoordinator(children: ChildProcess[]): Promise<{ url: string; process: ChildProcess }> {
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/registry/coordinator-cli.ts", "--port", "0",
    "--heartbeat-timeout-ms", "1200", "--token-env", "OPENSTORE_048B_TOKEN",
  ], spawnOptions());
  children.push(child);
  const event = await waitForJson(child, (value) => value.event === "started");
  return { url: String(event.url), process: child };
}

async function startNode(
  root: string,
  name: string,
  coordinatorUrl: string,
  children: ChildProcess[],
): Promise<{ peerId: string; process: ChildProcess }> {
  const nodeRoot = join(root, name);
  await mkdir(nodeRoot, { recursive: true });
  const identityPath = join(nodeRoot, "identity.json");
  try { await access(identityPath); } catch { await saveIdentity(createIdentity(), PASSWORD, identityPath); }
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/storage-node/libp2p-cli.ts",
    "--storage-dir", join(nodeRoot, "pieces"), "--identity", identityPath,
    "--password-env", "OPENSTORE_048B_PASSWORD", "--listen", "/ip4/127.0.0.1/tcp/0",
    "--capacity-bytes", "1048576", "--max-piece-bytes", "65536",
    "--coordinator-url", coordinatorUrl, "--coordinator-token-env", "OPENSTORE_048B_TOKEN",
    "--heartbeat-interval-ms", "250",
  ], spawnOptions());
  children.push(child);
  const event = await waitForJson(child, (value) => value.event === "started");
  return { peerId: String(event.peerId), process: child };
}

async function waitForJson(
  child: ChildProcess,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("process readiness timed out")), 20_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (predicate(value)) {
              clearTimeout(timer);
              child.stdout?.off("data", onData);
              resolve(value);
              return;
            }
          } catch {}
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", () => undefined);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`process exited before readiness: ${code}`));
      }
    });
  });
}

async function waitForEndpoints(
  adapter: ReturnType<typeof createCoordinatorAdapter>,
  count: number,
): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await poll(async () => {
    endpoints = await adapter.refresh();
    return endpoints.length === count;
  });
  return endpoints;
}

async function poll(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("bounded integration polling timed out");
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
