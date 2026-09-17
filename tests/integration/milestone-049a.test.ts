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
import { createManifestStore } from "../../packages/manifest/store.js";
import { createRepairScheduler } from "../../apps/client/repair-scheduler.js";

const PASSWORD = "milestone-049a-password";
const TOKEN = "milestone-049a-token";

describe("Milestone 049A repair scheduler", () => {
  it("rediscovers after restart and repairs an actually lost replica", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-049a-"));
    const children: ChildProcess[] = [];
    try {
      const coordinator = await startCoordinator(children);
      const registry = createRegistryClient({ baseUrl: coordinator.url, token: TOKEN });
      const a = await startNode(root, "a", coordinator.url, children);
      const b = await startNode(root, "b", coordinator.url, children);
      const c = await startNode(root, "c", coordinator.url, children);
      await poll(async () => (await registry.nodes()).filter((node) => node.available).length === 3);
      const adapter = createCoordinatorAdapter({ baseUrl: coordinator.url, token: TOKEN });
      const endpoints = await waitForEndpoints(adapter, 3);
      const endpointA = endpoints.find((endpoint) => endpoint.id === a.peerId);
      const endpointB = endpoints.find((endpoint) => endpoint.id === b.peerId);
      if (!endpointA || !endpointB) throw new Error("replica endpoints were not discovered");
      const store = createManifestStore({ dir: join(root, "client-manifests") });
      const plaintext = Buffer.from("049A scheduler plaintext");
      const uploaded = await uploadBuffer(plaintext, "049a.txt", [endpointA, endpointB], {
        replicationFactor: 2,
        manifestStore: store,
      });
      const pieceId = uploaded.manifest.chunks[0].pieceId;
      const ciphertext = await readFile(join(root, "a", "pieces", pieceId));

      children.splice(children.indexOf(b.process), 1);
      await stopChild(b.process);
      const restarted = await startNode(root, "b", coordinator.url, children);
      await poll(async () => (await registry.nodes()).some((node) => node.nodeId === restarted.peerId && node.available));
      const noRepairScheduler = createRepairScheduler({
        manifestStore: store,
        coordinator: adapter,
        options: {
          repairOptions: { observationCount: 2, observationIntervalMs: 0, gracePeriodMs: 0, retryAttempts: 1 },
        },
      });
      await noRepairScheduler.runOnce();
      expect((await store.load(uploaded.manifest.fileId))?.chunks[0].nodeIds).toEqual([a.peerId, b.peerId]);

      children.splice(children.indexOf(restarted.process), 1);
      await stopChild(restarted.process);
      const repairScheduler = createRepairScheduler({
        manifestStore: store,
        coordinator: adapter,
        options: {
          repairOptions: { observationCount: 2, observationIntervalMs: 50, gracePeriodMs: 50, retryAttempts: 1 },
        },
      });
      await poll(async () => {
        const node = (await registry.nodes()).find((candidate) => candidate.nodeId === restarted.peerId);
        return node === undefined || node.available === false;
      });
      await repairScheduler.runOnce();
      const repaired = await store.load(uploaded.manifest.fileId);
      expect(repaired?.chunks[0].nodeIds).toEqual([a.peerId, c.peerId]);
      expect(await readFile(join(root, "c", "pieces", pieceId))).toEqual(ciphertext);
      expect(await downloadBuffer(repaired!, uploaded.encryptionKey, [], { coordinator: adapter })).toEqual(plaintext);
      expect(JSON.stringify(repaired)).not.toMatch(/password|token|privateKey|recoveryPhrase/i);
      repairScheduler.stop();
    } finally {
      await Promise.all(children.reverse().map((child) => stopChild(child)));
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

function spawnOptions(): SpawnOptions {
  return {
    cwd: process.cwd(),
    env: { ...process.env, OPENSTORE_049A_TOKEN: TOKEN, OPENSTORE_049A_PASSWORD: PASSWORD },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
}

async function startCoordinator(children: ChildProcess[]): Promise<{ url: string; process: ChildProcess }> {
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/registry/coordinator-cli.ts", "--port", "0",
    "--heartbeat-timeout-ms", "1200", "--token-env", "OPENSTORE_049A_TOKEN",
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
    "--password-env", "OPENSTORE_049A_PASSWORD", "--listen", "/ip4/127.0.0.1/tcp/0",
    "--capacity-bytes", "1048576", "--max-piece-bytes", "65536",
    "--coordinator-url", coordinatorUrl, "--coordinator-token-env", "OPENSTORE_049A_TOKEN",
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
        if (!line) continue;
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
) {
  let endpoints: Awaited<ReturnType<typeof adapter.refresh>> = [];
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
