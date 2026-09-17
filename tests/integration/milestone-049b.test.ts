import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { hashPieceId, buildManifest } from "../../packages/manifest/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { createOperationRecord, createOperationRecordStore, createPieceClaim, createClaimOnNode, markClaimReferencedOnNode, releaseClaimOnNode, storeClaimedPieceOnNode, deletePieceIfUnclaimedOnNode, reconcileCommittedOperation } from "../../apps/client/provenance.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";

const PASSWORD = "milestone-049b-password";
const TOKEN = "milestone-049b-token";

describe("Milestone 049B provenance lifecycle", () => {
  it("retains claims across client/node restart and refuses referenced deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-049b-"));
    const children: ChildProcess[] = [];
    try {
      const coordinator = await startCoordinator(children);
      const registry = createRegistryClient({ baseUrl: coordinator.url, token: TOKEN });
      const node = await startNode(root, coordinator.url, children);
      await poll(async () => (await registry.nodes()).some((candidate) => candidate.nodeId === node.peerId && candidate.available));
      const adapter = createCoordinatorAdapter({ baseUrl: coordinator.url, token: TOKEN });
      let endpoint = (await waitForEndpoints(adapter, 1))[0]!;
      const identity = createIdentity();
      const piece = Buffer.from("opaque encrypted piece bytes");
      const pieceId = hashPieceId(piece);
      const operationStore = createOperationRecordStore(join(root, "client", "operations"));
      const claim = createPieceClaim(pieceId, "upload", identity);
      const operation = createOperationRecord(pieceId, claim, node.peerId, "upload", 0);

      await createClaimOnNode(endpoint, claim, identity, { timeoutMs: 5000 });
      await operationStore.create(operation);
      await storeClaimedPieceOnNode(endpoint, pieceId, claim.claimId, piece, identity, { timeoutMs: 5000 });
      await operationStore.update(operation.operationId, "stored");
      await operationStore.update(operation.operationId, "verified");

      children[1]!.kill("SIGKILL");
      await poll(async () => (await registry.nodes()).some((candidate) => candidate.nodeId === node.peerId && !candidate.available));
      const restarted = await startNode(root, coordinator.url, children);
      expect(restarted.peerId).toBe(node.peerId);
      endpoint = (await waitForEndpoints(adapter, 1))[0]!;
      const reloaded = await operationStore.load(operation.operationId);
      expect(reloaded?.state).toBe("verified");
      expect(await readFile(join(root, "node", "pieces", pieceId))).toEqual(piece);

      const manifestStore = createManifestStore({ dir: join(root, "client", "manifests") });
      const manifest = buildManifest({
        fileId: "049bfile",
        filename: "opaque",
        size: piece.length,
        chunkSize: piece.length,
        cryptoVersion: 1,
        chunks: [{ index: 0, pieceId, plaintextHash: "a".repeat(64), plaintextSize: piece.length, encryptedSize: piece.length, nodeIds: [node.peerId] }],
      });
      await manifestStore.save(manifest);
      await reconcileCommittedOperation("049bfile", reloaded!, manifestStore, [endpoint], identity, operationStore, { timeoutMs: 5000 });
      expect((await operationStore.load(operation.operationId))?.state).toBe("committed");
      await markClaimReferencedOnNode(endpoint, pieceId, claim.claimId, identity, { timeoutMs: 5000 });
      expect((await deletePieceIfUnclaimedOnNode(endpoint, pieceId, identity, { timeoutMs: 5000 })).status).toBe("still-claimed");

      const other = createIdentity();
      await expect(releaseClaimOnNode(endpoint, pieceId, claim.claimId, other, { timeoutMs: 5000 })).rejects.toThrow();
      await expect((await deletePieceIfUnclaimedOnNode(endpoint, pieceId, other, { timeoutMs: 5000 })).status).toBe("still-claimed");
      expect(JSON.stringify(reloaded)).not.toContain("privateKey");
      expect(JSON.stringify(reloaded)).not.toContain("plaintext");
    } finally {
      await Promise.all(children.reverse().map((child) => stopChild(child)));
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

function spawnOptions(): SpawnOptions {
  return { cwd: process.cwd(), env: { ...process.env, OPENSTORE_049B_TOKEN: TOKEN, OPENSTORE_049B_PASSWORD: PASSWORD }, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
}

async function startCoordinator(children: ChildProcess[]): Promise<{ url: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/registry/coordinator-cli.ts", "--port", "0", "--heartbeat-timeout-ms", "1200", "--token-env", "OPENSTORE_049B_TOKEN"], spawnOptions());
  children.push(child);
  const event = await waitForJson(child, (value) => value.event === "started");
  return { url: String(event.url) };
}

async function startNode(root: string, coordinatorUrl: string, children: ChildProcess[]): Promise<{ peerId: string }> {
  const nodeRoot = join(root, "node");
  await mkdir(nodeRoot, { recursive: true });
  const identityPath = join(nodeRoot, "identity.json");
  try { await access(identityPath); } catch { await saveIdentity(createIdentity(), PASSWORD, identityPath); }
  const child = spawn(process.execPath, ["--import", "tsx", "apps/storage-node/libp2p-cli.ts", "--storage-dir", join(nodeRoot, "pieces"), "--identity", identityPath, "--password-env", "OPENSTORE_049B_PASSWORD", "--listen", "/ip4/127.0.0.1/tcp/0", "--capacity-bytes", "1048576", "--max-piece-bytes", "65536", "--coordinator-url", coordinatorUrl, "--coordinator-token-env", "OPENSTORE_049B_TOKEN", "--heartbeat-interval-ms", "250"], spawnOptions());
  children.push(child);
  const event = await waitForJson(child, (value) => value.event === "started");
  return { peerId: String(event.peerId) };
}

async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>, count: number): Promise<StorageNodeEndpoint[]> {
  let endpoints: StorageNodeEndpoint[] = [];
  await poll(async () => { endpoints = await adapter.refresh(); return endpoints.length === count; });
  return endpoints;
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
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (predicate(value)) { clearTimeout(timer); child.stdout?.off("data", onData); resolve(value); return; }
        } catch {}
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", () => undefined);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function poll(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("bounded integration polling timed out");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); resolve(); }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
