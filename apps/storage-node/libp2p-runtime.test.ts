import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
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
  });

  it("loads a keystore and starts with its stable identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-libp2p-runtime-"));
    const keystore = join(dir, "identity.json");
    const identity = createIdentity();
    await saveIdentity(identity, "test-password", keystore);
    const runtime = await createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"), identityPath: keystore, identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
    });
    await runtime.start();
    expect(runtime.node.peerId).toBeTruthy();
    await runtime.stop();
    await expect(createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"), identityPath: keystore, identityPassword: "wrong",
    })).rejects.toThrow(/decrypt|password|keystore/i);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  it("emits safe lifecycle states and reaches stopped cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-libp2p-lifecycle-"));
    const keystore = join(dir, "identity.json");
    await saveIdentity(createIdentity(), "test-password", keystore);
    const events: Array<{ state: string; error?: string }> = [];
    const runtime = await createLibp2pStorageNodeRuntime({
      storageDir: join(dir, "pieces"),
      identityPath: keystore,
      identityPassword: "test-password",
      listenAddrs: ["/ip4/127.0.0.1/tcp/0"],
      lifecycleEventCallback: (event) => events.push({ state: event.state, error: event.error }),
    });
    await runtime.start();
    expect(runtime.state).toBe("registered");
    await runtime.stop();
    expect(runtime.state).toBe("stopped");
    expect(events.map((event) => event.state)).toEqual(["starting", "registered", "stopped"]);
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
