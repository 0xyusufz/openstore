import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { createRegistryClient, type RegistryClient } from "../../packages/registry/coordinator.js";
import { createCoordinatorAdapter, resolveManifestReplicaEndpoints } from "../../apps/client/coordinator.js";
import { buildManifest } from "../../packages/manifest/index.js";
import { deleteFile, DeleteFileError } from "../../apps/client/delete.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { downloadBuffer } from "../../apps/client/download.js";

const PROCESS_PASSWORD = "milestone-047-process-password";
const PROCESS_TOKEN = "milestone-047-process-token";

describe("Milestone 047 resilience and outage policy", () => {
  it("coalesces refreshes and preserves the last-known endpoint catalog", async () => {
    let calls = 0;
    const adapter = createCoordinatorAdapter({
      baseUrl: "http://coordinator.invalid",
      fetch: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ nodes: [{
          nodeId: "node-a", publicKey: Buffer.alloc(44).toString("base64"),
          baseUrl: "http://127.0.0.1:1", available: true,
          capacity: { allocatedBytes: 10, usedBytes: 0, availableBytes: 10 },
          reliability: { score: 100, storageScore: 100 },
        }] }), { status: 200 });
      },
    });
    await Promise.all([adapter.refresh(), adapter.refresh(), adapter.refresh()]);
    expect(calls).toBe(1);
    expect(adapter.getEndpoints()).toHaveLength(1);
  });

  it("resolves only manifest replicas and does not invent replacements", () => {
    const manifest = buildManifest({
      fileId: "file", filename: "file", size: 1, chunkSize: 1, cryptoVersion: 1,
      chunks: [{
        index: 0, pieceId: "a".repeat(64), plaintextHash: "b".repeat(64),
        plaintextSize: 1, encryptedSize: 1, nodeIds: ["node-a"],
      }],
    });
    const endpoints = [{ id: "node-a", baseUrl: "http://a" }, { id: "new", baseUrl: "http://new" }];
    expect(resolveManifestReplicaEndpoints(manifest, endpoints)).toEqual([endpoints[0]]);
  });

  it("reports unavailable known manifest replicas instead of fake deletion success", async () => {
    const adapter = createCoordinatorAdapter({
      baseUrl: "http://coordinator.invalid",
      fetch: async () => new Response(JSON.stringify({ nodes: [{
        nodeId: "node-a", publicKey: Buffer.alloc(44).toString("base64"),
        baseUrl: "http://127.0.0.1:1", available: false,
        capacity: { allocatedBytes: 10, usedBytes: 0, availableBytes: 10 },
        reliability: { score: 0, storageScore: 0 },
      }] }), { status: 200 }),
    });
    const manifest = buildManifest({
      fileId: "file", filename: "file", size: 1, chunkSize: 1, cryptoVersion: 1,
      chunks: [{ index: 0, pieceId: "a".repeat(64), plaintextHash: "b".repeat(64),
        plaintextSize: 1, encryptedSize: 1, nodeIds: ["node-a"] }],
    });
    await adapter.refresh();
    await expect(deleteFile(manifest, [], { coordinator: adapter, timeoutMs: 10 }))
      .rejects.toBeInstanceOf(DeleteFileError);
  });

  it("covers authenticated process outage, failover, delete reporting, and identity restart", async () => {
    const root = await mkdtemp(join(process.cwd(), ".milestone-047-process-"));
    const children: ChildProcess[] = [];
    try {
      const coordinator = await startCoordinator(children);
      const registry = createRegistryClient({ baseUrl: coordinator.url, token: PROCESS_TOKEN });
      const first = await startNode(root, "a", coordinator.url, children);
      const second = await startNode(root, "b", coordinator.url, children);
      await poll(async () => (await registry.nodes()).filter((node) => node.available).length === 2);

      const adapter = createCoordinatorAdapter({ baseUrl: coordinator.url, token: PROCESS_TOKEN });
      const uploaded = await uploadBuffer(Buffer.from("047 process resilience"), "047.txt", [], {
        coordinator: adapter,
        replicationFactor: 2,
      });
      const replicaIds = uploaded.manifest.chunks[0]?.nodeIds ?? [];
      expect(new Set(replicaIds).size).toBe(2);

      second.process.kill("SIGKILL");
      await poll(async () => (await registry.nodes()).some((node) => node.nodeId === second.peerId && !node.available));
      await expect(downloadBuffer(uploaded.manifest, uploaded.encryptionKey, [], {
        coordinator: adapter,
        retryAttempts: 1,
      })).resolves.toEqual(Buffer.from("047 process resilience"));

      await adapter.refreshSafe();
      await expect(deleteFile(uploaded.manifest, [], { coordinator: adapter, timeoutMs: 25 }))
        .rejects.toBeInstanceOf(DeleteFileError);

      const restarted = await startNode(root, "b", coordinator.url, children);
      expect(restarted.peerId).toBe(second.peerId);
      await poll(async () => (await registry.nodes()).filter((node) => node.available).length === 2);
    } finally {
      await Promise.all(children.reverse().map((child) => stopChild(child)));
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

function spawnOptions(): SpawnOptions {
  return {
    cwd: process.cwd(),
    env: { ...process.env, OPENSTORE_047_TOKEN: PROCESS_TOKEN, OPENSTORE_047_PASSWORD: PROCESS_PASSWORD },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
}

async function startCoordinator(children: ChildProcess[]): Promise<{ url: string; process: ChildProcess }> {
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/registry/coordinator-cli.ts", "--port", "0",
    "--heartbeat-timeout-ms", "1200", "--token-env", "OPENSTORE_047_TOKEN",
  ], spawnOptions());
  children.push(child);
  const event = await waitForJson(child, (value) => value.event === "started");
  return { url: String(event.url), process: child };
}

async function startNode(root: string, name: string, coordinatorUrl: string, children: ChildProcess[]): Promise<{ peerId: string; process: ChildProcess }> {
  const nodeRoot = join(root, name);
  await mkdir(nodeRoot, { recursive: true });
  const identityPath = join(nodeRoot, "identity.json");
  try { await access(identityPath); } catch { await saveIdentity(createIdentity(), PROCESS_PASSWORD, identityPath); }
  const child = spawn(process.execPath, [
    "--import", "tsx", "apps/storage-node/libp2p-cli.ts",
    "--storage-dir", join(nodeRoot, "pieces"), "--identity", identityPath,
    "--password-env", "OPENSTORE_047_PASSWORD", "--listen", "/ip4/127.0.0.1/tcp/0",
    "--capacity-bytes", "1048576", "--max-piece-bytes", "65536",
    "--coordinator-url", coordinatorUrl, "--coordinator-token-env", "OPENSTORE_047_TOKEN",
    "--heartbeat-interval-ms", "250",
  ], spawnOptions());
  children.push(child);
  const event = await waitForJson(child, (value) => value.event === "started");
  return { peerId: String(event.peerId), process: child };
}

async function waitForJson(child: ChildProcess, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
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
          } catch { /* readiness ignores diagnostics */ }
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

async function poll(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("bounded process polling timed out");
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
