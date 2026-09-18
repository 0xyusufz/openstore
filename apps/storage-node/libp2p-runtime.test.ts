import { describe, expect, it } from "vitest";
import { access, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, type ChildProcess } from "child_process";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { createLibp2pStorageNodeRuntime, validateLibp2pStorageNodeRuntimeConfig } from "./libp2p-runtime.js";
import { peerIdFromOpenStorePublicKey } from "../../packages/p2p/identity-binding.js";
import { Libp2pPieceTransport } from "../../packages/p2p/libp2p.js";

describe("libp2p storage-node runtime", () => {
  it("validates required configuration and rejects invalid quotas", () => {
    expect(() => validateLibp2pStorageNodeRuntimeConfig({})).toThrow(/storageDir/);
    expect(() => validateLibp2pStorageNodeRuntimeConfig({
      storageDir: "pieces", identityPath: "identity.json", identityPassword: "secret", capacityBytes: 0,
    })).toThrow(/capacityBytes/);
    expect(() => validateLibp2pStorageNodeRuntimeConfig({
      storageDir: "pieces", identityPath: "identity.json", identityPassword: "secret", allocationPath: "",
    })).toThrow(/allocationPath/);
  });

  it("loads a keystore and starts with its stable identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-libp2p-runtime-"));
    const keystore = join(dir, "identity.json");
    const identity = createIdentity();
    await saveIdentity(identity, "test-password", keystore);
    const runtime = await createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"), identityPath: keystore, identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
      readinessFile: join(dir, "ready"),
    });
    await runtime.start();
    expect(runtime.node.peerId).toBeTruthy();
    await expect(access(join(dir, "ready"))).resolves.toBeUndefined();
    await runtime.stop();
    await expect(access(join(dir, "ready"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"), identityPath: keystore, identityPassword: "wrong",
    })).rejects.toThrow(/decrypt|password|keystore/i);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  it("emits safe lifecycle states and reaches stopped cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-libp2p-lifecycle-"));
    const keystore = join(dir, "identity.json");
    await saveIdentity(createIdentity(), "test-password", keystore);
    const events: Array<{ state: string; type?: string; error?: string }> = [];
    const runtime = await createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"),
      identityPath: keystore,
      identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
      lifecycleEventCallback: (event) => events.push({ state: event.state, type: event.type, error: event.error }),
    });
    await runtime.start();
    expect(runtime.state).toBe("registered");
    const snapshot = await runtime.statusSnapshot();
    expect(snapshot.peerId).toBe(runtime.node.peerId);
    expect(snapshot.coordinatorConfigured).toBe(false);
    expect(snapshot.shuttingDown).toBe(false);
    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    expect(events.map((event) => event.state)).toEqual(["starting", "registered", "stopped", "stopped"]);
    expect(events.map((event) => event.type)).toContain("shutdown.completed");
    expect(events.every((event) => !event.error || !/password|token|private key|recovery phrase/i.test(event.error))).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  it("runs two independent CLI processes and retrieves a piece after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-libp2p-process-"));
    const identity = createIdentity();
    const keystore = join(dir, "identity.json");
    await saveIdentity(identity, "test-password", keystore);
    const peerId = peerIdFromOpenStorePublicKey(identity.publicKey);
    const descriptor = [{
      nodeId: peerId,
      baseUrl: `libp2p://${peerId}`,
      multiaddr: `/ip4/127.0.0.1/tcp/43102/p2p/${peerId}`,
      identity: { publicKey: identity.publicKey.toString("base64") },
      identityBinding: peerId,
      capabilities: { pieceStore: true, pieceGet: true, pieceDelete: true, allocatedBytes: 1024 * 1024, availableBytes: 1024 * 1024 },
    }];
    const bootstrapPath = join(dir, "bootstrap.json");
    await writeFile(bootstrapPath, JSON.stringify(descriptor), { mode: 0o600 });
    const node = spawn(process.execPath, ["--import", "tsx", "apps/storage-node/libp2p-cli.ts",
      "--storage-dir", join(dir, "pieces"), "--identity", keystore, "--password-env", "OPENSTORE_TEST_PASSWORD",
      "--listen", "/ip4/127.0.0.1/tcp/43102"], {
      env: { ...process.env, OPENSTORE_TEST_PASSWORD: "test-password" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForOutput(node, "started");
      const transport = new Libp2pPieceTransport();
      const endpoint = {
        nodeId: peerId,
        baseUrl: `libp2p://${peerId}`,
        multiaddr: descriptor[0].multiaddr,
        identityBinding: peerId,
        identity: descriptor[0].identity,
      };
      expect((await transport.storePiece(endpoint, "persisted-piece", Buffer.from("opaque"), { timeoutMs: 5_000 })).status).toBe(201);
      expect((await transport.getPiece(endpoint, "persisted-piece", { timeoutMs: 5_000 })).bytes?.toString()).toBe("opaque");
      await stopChild(node);
      const restarted = spawn(process.execPath, ["--import", "tsx", "apps/storage-node/libp2p-cli.ts",
        "--storage-dir", join(dir, "pieces"), "--identity", keystore, "--password-env", "OPENSTORE_TEST_PASSWORD",
        "--listen", "/ip4/127.0.0.1/tcp/43102", "--bootstrap", bootstrapPath], {
        env: { ...process.env, OPENSTORE_TEST_PASSWORD: "test-password" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        await waitForOutput(restarted, "started");
        expect((await transport.getPiece(endpoint, "persisted-piece", { timeoutMs: 5_000 })).bytes?.toString()).toBe("opaque");
      } finally {
        await stopChild(restarted);
      }
    } finally {
      if (node.exitCode === null) await stopChild(node);
      await rm(dir, { recursive: true, force: true });
    }
  }, 45_000);

  it("enforces and restores durable allocation through the real libp2p runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-libp2p-allocation-"));
    const keystore = join(dir, "identity.json");
    const storageDir = join(dir, "pieces");
    const allocationPath = join(storageDir, "allocation.json");
    await saveIdentity(createIdentity(), "test-password", keystore);
    const config = {
      storageDir, allocationPath, capacityBytes: 200,
      identityPath: keystore, identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
    };
    const first = await createLibp2pStorageNodeRuntime(config);
    await first.start();
    const endpoint = {
      nodeId: first.node.peerId,
      baseUrl: `libp2p://${first.node.peerId}`,
      multiaddr: first.node.listenAddrs[0],
      identityBinding: first.node.peerId,
      identity: first.node.applicationIdentity,
    };
    const transport = new Libp2pPieceTransport();
    try {
      expect((await transport.storePiece(endpoint, "near-limit", Buffer.alloc(150), { timeoutMs: 5_000 })).status).toBe(201);
      expect((await first.statusSnapshot()).capacity).toMatchObject({ allocatedBytes: 200, usedBytes: 150, availableBytes: 50 });
      expect((await transport.storePiece(endpoint, "over-limit", Buffer.alloc(100), { timeoutMs: 5_000 })).status).toBe(507);
      expect((await transport.getPiece(endpoint, "near-limit", { timeoutMs: 5_000 })).bytes?.length).toBe(150);
    } finally {
      await first.stop();
    }
    const second = await createLibp2pStorageNodeRuntime({ ...config, capacityBytes: undefined });
    await second.start();
    try {
      const snapshot = await second.statusSnapshot();
      expect(snapshot.capacity).toMatchObject({ allocatedBytes: 200, usedBytes: 150, availableBytes: 50 });
      expect(JSON.stringify(snapshot)).not.toMatch(/password|private|secret|plaintext|pieces|allocation\.json/i);
    } finally {
      await second.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when durable allocation state is corrupt or impossible", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-libp2p-corrupt-allocation-"));
    const keystore = join(dir, "identity.json");
    const allocationPath = join(dir, "allocation.json");
    await saveIdentity(createIdentity(), "test-password", keystore);
    await writeFile(allocationPath, JSON.stringify({ version: 1, allocationBytes: 20, usedBytes: 21, reservedBytes: 0, physicalBytes: 20, usableBytes: 20 }));
    await expect(createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"), allocationPath,
      identityPath: keystore, identityPassword: "test-password",
    })).rejects.toThrow(/impossible/i);
    await writeFile(allocationPath, "{not-json");
    await expect(createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"), allocationPath,
      identityPath: keystore, identityPassword: "test-password",
    })).rejects.toThrow(/corrupt/i);
    await rm(dir, { recursive: true, force: true });
  });
});

async function waitForOutput(child: ChildProcess, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`child did not emit ${text}: ${output}`)), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(text)) { clearTimeout(timer); resolve(); }
    });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) { clearTimeout(timer); reject(new Error(`child exited ${code}: ${output}`)); }
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
