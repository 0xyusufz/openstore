import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { downloadBuffer } from "../../apps/client/download.js";

const PASSWORD = "milestone-045-password";
const TOKEN = "milestone-045-token";

describe("Milestone 045 coordinator restart and recovery", () => {
  it("reloads durable state and recovers live standalone nodes", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-045-"));
    const children: ChildProcess[] = [];
    try {
      const persistence = join(root, "coordinator", "registry.json");
      const first = await startCoordinator(persistence, children);
      const registry = createRegistryClient({ baseUrl: first.url, token: TOKEN });
      const nodes = await Promise.all([
        startNode(root, "a", first.url, children),
        startNode(root, "b", first.url, children),
      ]);
      await poll(async () => (await registry.nodes()).filter((node) => node.available).length === 2);

      const before = await registry.nodes();
      const beforeById = new Map(before.map((node) => [node.nodeId, node]));
      expect(beforeById.get(nodes[0].peerId)?.transport).toBe("libp2p");
      expect(beforeById.get(nodes[0].peerId)?.capacity.allocatedBytes).toBe(4 * 1024 * 1024);
      expect(beforeById.get(nodes[0].peerId)?.reliability).toBeDefined();

      const adapter = createCoordinatorAdapter({ baseUrl: first.url, token: TOKEN });
      const uploaded = await uploadBuffer(Buffer.from("durable coordinator recovery"), "recovery.txt", [], {
        coordinator: adapter,
        replicationFactor: 2,
      });
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, [], { coordinator: adapter }))
        .toEqual(Buffer.from("durable coordinator recovery"));

      await stopChild(first.process);
      const unavailable = createRegistryClient({ baseUrl: first.url, token: TOKEN });
      await expect(unavailable.nodes()).rejects.toBeInstanceOf(Error);

      const second = await startCoordinator(persistence, children, first.port);
      const reloaded = createRegistryClient({ baseUrl: second.url, token: TOKEN });
      const persisted = await reloaded.nodes();
      expect(persisted).toHaveLength(2);
      expect(persisted.map((node) => node.nodeId).sort()).toEqual(nodes.map((node) => node.peerId).sort());
      expect(persisted.every((node) => node.transport === "libp2p")).toBe(true);
      expect(persisted.every((node) => node.capacity.allocatedBytes === 4 * 1024 * 1024)).toBe(true);
      for (const node of persisted) {
        const previous = beforeById.get(node.nodeId)?.reliability;
        expect(node.reliability.successfulHeartbeats).toBeGreaterThanOrEqual(previous?.successfulHeartbeats ?? 0);
        expect(node.reliability.missedHeartbeats).toBe(previous?.missedHeartbeats ?? 0);
      }

      const recoveredAdapter = createCoordinatorAdapter({ baseUrl: second.url, token: TOKEN });
      await pollForAvailable(reloaded, 2);
      await poll(async () => (await recoveredAdapter.refreshSafe()).length === 2);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, [], {
        coordinator: recoveredAdapter,
      })).toEqual(Buffer.from("durable coordinator recovery"));

      await killChild(nodes[1].process);
      await poll(async () => (await reloaded.nodes()).some((node) => node.nodeId === nodes[1].peerId && node.available === false));
      expect((await recoveredAdapter.refreshSafe()).map((endpoint) => endpoint.id)).not.toContain(nodes[1].peerId);

      const restarted = await startNode(root, "b", second.url, children);
      expect(restarted.peerId).toBe(nodes[1].peerId);
      try {
        await pollForAvailable(reloaded, 2);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; node lifecycle: ${restarted.lifecycle.join(" | ")}`);
      }
      expect(await stat(join(root, "b", "pieces", uploaded.manifest.chunks[0].pieceId))).toBeTruthy();
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, [], {
        coordinator: recoveredAdapter,
      })).toEqual(Buffer.from("durable coordinator recovery"));
      expect(await readFile(persistence, "utf8")).not.toContain(PASSWORD);
    } finally {
      await Promise.all(children.reverse().map((child) => stopChild(child)));
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

function spawnOptions(): SpawnOptions {
  return {
    cwd: process.cwd(),
    env: { ...process.env, OPENSTORE_045_TOKEN: TOKEN, OPENSTORE_045_PASSWORD: PASSWORD },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
}

async function startCoordinator(
  persistence: string,
  children: ChildProcess[],
  port = 0,
): Promise<{ process: ChildProcess; url: string; port: number }> {
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/registry/coordinator-cli.ts",
    "--port", String(port), "--persistence", persistence,
    "--heartbeat-timeout-ms", "5000", "--token-env", "OPENSTORE_045_TOKEN",
  ], spawnOptions());
  children.push(child);
  const event = await waitForJson(child, (value) => value.event === "started");
  const url = String(event.url);
  return { process: child, url, port: Number(new URL(url).port) };
}

async function startNode(
  root: string,
  name: string,
  coordinatorUrl: string,
  children: ChildProcess[],
): Promise<{ process: ChildProcess; peerId: string; lifecycle: string[] }> {
  const nodeRoot = join(root, name);
  await mkdir(nodeRoot, { recursive: true });
  const identityPath = join(nodeRoot, "identity.json");
  try { await access(identityPath); } catch { await saveIdentity(createIdentity(), PASSWORD, identityPath); }
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/storage-node/libp2p-cli.ts",
    "--storage-dir", join(nodeRoot, "pieces"), "--identity", identityPath,
    "--password-env", "OPENSTORE_045_PASSWORD", "--listen", "/ip4/127.0.0.1/tcp/0",
    "--capacity-bytes", String(4 * 1024 * 1024), "--max-piece-bytes", "65536",
    "--coordinator-url", coordinatorUrl, "--coordinator-token-env", "OPENSTORE_045_TOKEN",
    "--heartbeat-interval-ms", "300", "--coordinator-retry-attempts", "3",
    "--coordinator-retry-backoff-ms", "100", "--coordinator-retry-max-backoff-ms", "500",
  ], spawnOptions());
  children.push(child);
  const lifecycle: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.includes('"event":"lifecycle"')) lifecycle.push(line);
    }
  });
  const event = await waitForJson(child, (value) => value.event === "started");
  return { process: child, peerId: String(event.peerId), lifecycle };
}

async function waitForJson(child: ChildProcess, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("process readiness timed out")), 20_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
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
        newline = buffer.indexOf("\n");
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

async function poll(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("bounded recovery polling timed out");
}

async function pollForAvailable(client: ReturnType<typeof createRegistryClient>, count: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await client.nodes();
    if ((last as Array<{ available: boolean }>).filter((node) => node.available).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`recovery availability timed out: ${JSON.stringify(last)}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
