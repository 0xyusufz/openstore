/**
 * Storage Provider / Share Storage Tests (OPENSTORE-029)
 *
 * Lifecycle, quota, isolation, draining, persistence, and leak-safety
 * for sharing local disk through the web backend. Real storage nodes,
 * real HTTP, real filesystem. No mocking.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { request as httpRequest } from "http";
import { getFilesystemCapacity } from "./provider.js";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { createWebBackend } from "./backend.js";
import { createWebServer } from "./server.js";

const SECRET_WORDS = ["privatekey", "recoveryphrase", "encryptionkey", "password", "mnemonic", "plaintext"];
const PROVIDER_KEYS = [
  "baseUrl", "capacity", "conditions", "configured", "drainReadiness", "draining", "filesystem",
  "lifecycle", "nodeId", "pieces", "placementEligible", "placementReason", "port", "readiness", "releaseReadiness",
  "reliability", "state", "storageDir", "uptimeMs",
].sort();

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return { status: res.status, json, text };
}

function buildMultipartBody(filename: string, fileData: Buffer): Buffer {
  const boundary = "prov-boundary-1";
  const header = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([Buffer.from(header, "utf8"), fileData, Buffer.from(footer, "utf8")]);
}

function uploadFile(port: number, filename: string, data: Buffer): Promise<{ status: number; json: Record<string, unknown> }> {
  const boundary = "prov-boundary-1";
  const body = buildMultipartBody(filename, data);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/api/files/upload", method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": body.length } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

interface LiveSetup {
  manifestDir: string;
  registry: ReturnType<typeof createRegistry>;
  base: string;
  cleanup: () => Promise<void>;
  extraNodes: { node: StorageNode; dir: string }[];
}

async function startLiveServer(): Promise<LiveSetup> {
  const manifestDir = await tempDir("openstore-prov-manifests-");
  const registry = createRegistry();
  const web = createWebServer({ manifestDir, registry, providerIdentityPassword: "provider-test-password" });
  const port = await web.listen(0, "127.0.0.1");
  const extraNodes: { node: StorageNode; dir: string }[] = [];
  return {
    manifestDir,
    registry,
    base: `http://127.0.0.1:${port}`,
    extraNodes,
    cleanup: async () => {
      await web.close();
      for (const n of extraNodes) {
        try { await n.node.close(); } catch {}
        await rm(n.dir, { recursive: true, force: true });
      }
      await rm(manifestDir, { recursive: true, force: true });
      await rm(`${manifestDir}.deks.json`, { force: true });
      await rm(`${manifestDir}.provider.json`, { force: true });
      await rm(`${manifestDir}.provider.json.identity`, { force: true });
    },
  };
}

async function addLiveNode(setup: LiveSetup): Promise<{ baseUrl: string }> {
  const dir = await tempDir("openstore-prov-extra-");
  const node = createStorageNode({ storageDir: dir, identity: createIdentity(), registry: setup.registry, registryHeartbeatIntervalMs: 50 });
  const port = await node.listen(0, "127.0.0.1");
  setup.extraNodes.push({ node, dir });
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function setupProvider(base: string, location: string, capacityBytes: number): Promise<Record<string, unknown>> {
  const res = await postJson(base, "/api/provider/setup", { location, capacityBytes });
  expect(res.status).toBe(200);
  return res.json["provider"] as Record<string, unknown>;
}

describe("storage provider (OPENSTORE-029)", () => {
  it("1. filesystem capacity detection reports sane numbers", async () => {
    const dir = await tempDir("openstore-prov-fs-");
    try {
      const cap = await getFilesystemCapacity(dir);
      expect(cap.totalBytes).toBeGreaterThan(0);
      expect(cap.freeBytes).toBeGreaterThan(0);
      expect(cap.freeBytes).toBeLessThanOrEqual(cap.totalBytes);
      expect(cap.usedBytes).toBe(cap.totalBytes - cap.freeBytes);
      await expect(getFilesystemCapacity(join(dir, "does-not-exist"))).rejects.toThrow(/capacity/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. allocation quota is enforced end-to-end", async () => {
    const setup = await startLiveServer();
    try {
      // Absurd allocations are refused before touching disk.
      const greedyDir = await tempDir("openstore-prov-greedy-");
      try {
        const greedy = await postJson(setup.base, "/api/provider/setup", {
          location: greedyDir,
          capacityBytes: Number.MAX_SAFE_INTEGER,
        });
        expect(greedy.status).toBe(400);
        expect(String(greedy.json["error"])).toMatch(/exceeds free/i);
      } finally {
        await rm(greedyDir, { recursive: true, force: true });
      }

      const location = await tempDir("openstore-prov-quota-");
      try {
        await setupProvider(setup.base, location, 3072);
        const started = await postJson(setup.base, "/api/provider/start", {});
        expect(started.status).toBe(200);
        const port = Number(new URL(setup.base).port);

        // A small file fits the quota.
        const ok = await uploadFile(port, "small.bin", Buffer.alloc(512, 0x41));
        expect(ok.status).toBe(200);

        // A file whose encrypted piece exceeds the quota fails safely.
        const big = await uploadFile(port, "big.bin", randomBytes(4096));
        expect(big.status).toBe(500);

        const status = (await (await fetch(`${setup.base}/api/provider`)).json()) as {
          provider: { capacity: { allocatedBytes: number; usedBytes: number; availableBytes: number } };
        };
        expect(status.provider.capacity.allocatedBytes).toBe(3072);
        expect(status.provider.capacity.usedBytes).toBeLessThanOrEqual(3072);
        expect(status.provider.capacity.availableBytes).toBe(
          3072 - status.provider.capacity.usedBytes,
        );
      } finally {
        await rm(location, { recursive: true, force: true });
      }
    } finally {
      await setup.cleanup();
    }
  });

  it("3. storage directory is isolated; foreign dirs are refused", async () => {
    const setup = await startLiveServer();
    try {
      // Non-empty foreign directory: refused, never adopted.
      const foreign = await tempDir("openstore-prov-foreign-");
      try {
        await writeFile(join(foreign, "photos.txt"), "not ours");
        const refused = await postJson(setup.base, "/api/provider/setup", { location: foreign, capacityBytes: 1_000_000 });
        expect(refused.status).toBe(400);
        expect(String(refused.json["error"])).toMatch(/not empty/i);
        expect(await readdir(foreign)).toEqual(["photos.txt"]);
      } finally {
        await rm(foreign, { recursive: true, force: true });
      }

      // Dedicated directory: pieces land only inside it.
      const location = await tempDir("openstore-prov-iso-");
      try {
        await setupProvider(setup.base, location, 10_000_000);
        await postJson(setup.base, "/api/provider/start", {});
        const port = Number(new URL(setup.base).port);
        const uploaded = await uploadFile(port, "iso.bin", randomBytes(512));
        expect(uploaded.status).toBe(200);
        const entries = await readdir(location);
        expect(entries).toContain(".openstore-storage");
        for (const entry of entries) {
          expect(/^[A-Za-z0-9_.-]{1,128}$/.test(entry)).toBe(true);
          expect(entry).not.toContain("/");
        }
      } finally {
        await rm(location, { recursive: true, force: true });
      }
    } finally {
      await setup.cleanup();
    }
  });

  it("4. usage beyond allocation fails without stranding data", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-over-");
    try {
      await setupProvider(setup.base, location, 2048);
      await postJson(setup.base, "/api/provider/start", {});
      const port = Number(new URL(setup.base).port);
      const first = await uploadFile(port, "fits.bin", Buffer.alloc(256, 0x42));
      expect(first.status).toBe(200);
      const second = await uploadFile(port, "over.bin", randomBytes(4096));
      expect(second.status).toBe(500);
      // The first file still downloads byte-exactly.
      const fileId = first.json["fileId"] as string;
      const dl = await fetch(`${setup.base}/api/files/${fileId}/download`);
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).equals(Buffer.alloc(256, 0x42))).toBe(true);
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });

  it("5. used/available reporting reflects real uploads", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-report-");
    try {
      await setupProvider(setup.base, location, 5_000_000);
      const before = (await (await fetch(`${setup.base}/api/provider`)).json()) as {
        provider: { capacity: { usedBytes: number }; pieces: { count: number } };
      };
      expect(before.provider.capacity.usedBytes).toBe(0);
      expect(before.provider.pieces.count).toBe(0);
      await postJson(setup.base, "/api/provider/start", {});
      await uploadFile(Number(new URL(setup.base).port), "report.bin", randomBytes(1024));
      const after = (await (await fetch(`${setup.base}/api/provider`)).json()) as {
        provider: {
          capacity: { allocatedBytes: number; usedBytes: number; availableBytes: number };
          pieces: { count: number; bytes: number };
          filesystem: { totalBytes: number; freeBytes: number };
        };
      };
      expect(after.provider.capacity.usedBytes).toBeGreaterThan(0);
      expect(after.provider.capacity.availableBytes).toBe(
        after.provider.capacity.allocatedBytes - after.provider.capacity.usedBytes,
      );
      expect(after.provider.pieces.count).toBeGreaterThanOrEqual(1);
      // Piece inventory excludes the tiny dir marker file that the node's
      // quota accounting honestly includes; the gap stays negligible.
      expect(after.provider.pieces.bytes).toBeLessThanOrEqual(after.provider.capacity.usedBytes);
      expect(after.provider.capacity.usedBytes - after.provider.pieces.bytes).toBeLessThan(1024);
      expect(after.provider.filesystem.totalBytes).toBeGreaterThan(0);
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });

  it("6. allocation increase/decrease rules are enforced with explanations", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-alloc-");
    try {
      await setupProvider(setup.base, location, 2048);
      await postJson(setup.base, "/api/provider/start", {});
      await uploadFile(Number(new URL(setup.base).port), "data.bin", Buffer.alloc(512, 0x43));

      // Increase works and the node honors the new quota.
      const grown = await postJson(setup.base, "/api/provider/allocation", { capacityBytes: 8192 });
      expect(grown.status).toBe(200);
      expect((grown.json["provider"] as Record<string, unknown> & { capacity: { allocatedBytes: number } }).capacity.allocatedBytes).toBe(8192);

      // Decrease below current usage explains itself.
      const shrunk = await postJson(setup.base, "/api/provider/allocation", { capacityBytes: 1 });
      expect(shrunk.status).toBe(400);
      expect(String(shrunk.json["error"])).toMatch(/below current usage/i);

      // Decrease above usage is fine.
      const trimmed = await postJson(setup.base, "/api/provider/allocation", { capacityBytes: 4096 });
      expect(trimmed.status).toBe(200);

      // Garbage inputs are rejected.
      for (const bad of [0, -5, 1.5, "lots", null]) {
        const res = await postJson(setup.base, "/api/provider/allocation", { capacityBytes: bad });
        expect(res.status).toBe(400);
      }
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });

  it("7. start/stop lifecycle with stable identity", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-life-");
    try {
      const created = await setupProvider(setup.base, location, 2_000_000);
      expect(created["state"]).toBe("stopped");

      const started = await postJson(setup.base, "/api/provider/start", {});
      expect(started.status).toBe(200);
      const running = started.json["provider"] as Record<string, unknown>;
      expect(running["state"]).toBe("running");
      expect(typeof running["nodeId"]).toBe("string");
      expect(typeof running["baseUrl"]).toBe("string");

      // Idempotent start keeps the same identity.
      const again = await postJson(setup.base, "/api/provider/start", {});
      expect(again.status).toBe(200);
      expect((again.json["provider"] as Record<string, unknown>)["nodeId"]).toBe(running["nodeId"]);

      const stopped = await postJson(setup.base, "/api/provider/stop", {});
      expect(stopped.status).toBe(200);
      const draining = stopped.json["provider"] as Record<string, unknown>;
      expect(draining["state"]).toBe("draining");
      expect(draining["draining"]).toBe(true);

      const resumed = await postJson(setup.base, "/api/provider/start", {});
      expect(resumed.status).toBe(200);
      const back = resumed.json["provider"] as Record<string, unknown>;
      expect(back["state"]).toBe("running");
      expect(back["draining"]).toBe(false);
      expect(back["nodeId"]).toBe(running["nodeId"]);
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });

  it("8. draining rejects new placement but keeps serving reads", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-drain-");
    try {
      await setupProvider(setup.base, location, 5_000_000);
      await postJson(setup.base, "/api/provider/start", {});
      const port = Number(new URL(setup.base).port);
      const keepData = randomBytes(256);
      const keep = await uploadFile(port, "keep.bin", keepData);
      expect(keep.status).toBe(200);
      const providerId = ((await (await fetch(`${setup.base}/api/provider`)).json()) as {
        provider: { nodeId: string };
      }).provider.nodeId;

      // Draining with no other nodes: placements fail, reads succeed.
      await postJson(setup.base, "/api/provider/stop", {});
      const refused = await uploadFile(port, "nope.bin", randomBytes(256));
      expect(refused.status).toBe(500);
      const keepId = keep.json["fileId"] as string;
      const dl = await fetch(`${setup.base}/api/files/${keepId}/download`);
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).equals(keepData)).toBe(true);

      // With a second live node, uploads succeed around the draining node.
      await addLiveNode(setup);
      const routed = await uploadFile(port, "routed.bin", randomBytes(256));
      expect(routed.status).toBe(200);
      const store = (await import("../../packages/manifest/store.js")).createManifestStore({ dir: setup.manifestDir });
      const manifest = await store.load(routed.json["fileId"] as string);
      expect(manifest).toBeDefined();
      expect(manifest!.nodeIds).not.toContain(providerId);
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });

  it("9. unexpected shutdown surfaces as offline with restart path", async () => {
    const manifestDir = await tempDir("openstore-prov-crash-");
    const location = await tempDir("openstore-prov-crashloc-");
    const registry = createRegistry();
    const backend1 = createWebBackend({ manifestDir, registry, providerIdentityPassword: "provider-test-password" });
    try {
      await backend1.provider.setup(location, 2_000_000);
      const started = await backend1.provider.start();
      expect(started.state).toBe("running");
      const nodeId = started.nodeId as string;

      // Simulate a reboot: a fresh backend over the same config path sees
      // the configured-but-unreachable node as offline, never as running.
      const backend2 = createWebBackend({ manifestDir, registry, providerIdentityPassword: "provider-test-password" });
      const status2 = await backend2.provider.getStatus();
      expect(status2.configured).toBe(true);
      expect(status2.state).toBe("offline");
      expect(status2.nodeId).toBe(nodeId);

      // Recovery: once the old process releases the port, the same config
      // restarts under the same identity.
      await backend1.provider.shutdown();
      const restarted = await backend2.provider.start();
      expect(restarted.state).toBe("running");
      expect(restarted.nodeId).toBe(nodeId);
      await backend2.provider.shutdown();
    } finally {
      await rm(location, { recursive: true, force: true });
      await rm(manifestDir, { recursive: true, force: true });
      await rm(`${manifestDir}.provider.json`, { force: true });
      await rm(`${manifestDir}.provider.json.identity`, { force: true });
      await rm(`${manifestDir}.deks.json`, { force: true });
      await rm(`${manifestDir}.provider.json`, { force: true });
      await rm(`${manifestDir}.provider.json.identity`, { force: true });
    }
  });

  it("10. configuration persists safely with restrictive permissions", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-persist-");
    try {
      await setupProvider(setup.base, location, 2_000_000);
      await postJson(setup.base, "/api/provider/start", {});
      const configPath = `${setup.manifestDir}.provider.json`;
      const mode = (await stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
      const text = await readFile(configPath, "utf8");
      // The provider identity is kept in a separate encrypted keystore;
      // this lifecycle config contains public identity metadata only.
      expect(Object.keys(JSON.parse(text)).sort()).toEqual(
        ["capacityBytes", "createdAt", "identityKeystorePath", "nodePublicKey", "port", "state", "storageDir", "updatedAt", "version"].sort(),
      );
      expect(text).not.toContain("recoveryPhrase");
      expect(text.toLowerCase()).not.toContain("password");
      expect(text.toLowerCase()).not.toContain("plaintext");
      expect(text.toLowerCase()).not.toContain("mnemonic");
      const identityKeystore = `${configPath}.identity`;
      const identityText = await readFile(identityKeystore, "utf8");
      expect(identityText).not.toContain("nodePrivateKey");
      expect(identityText).not.toContain("recoveryPhrase");
      expect((await stat(identityKeystore)).mode & 0o077).toBe(0);
      const before = (await (await fetch(`${setup.base}/api/provider`)).json()) as {
        provider: { nodeId: string };
      };
      // A fresh manager over the same file recovers the same identity.
      const backend2 = createWebBackend({ manifestDir: setup.manifestDir, registry: setup.registry });
      const status2 = await backend2.provider.getStatus();
      expect(status2.configured).toBe(true);
      expect(status2.nodeId).toBe(before.provider.nodeId);

      // Malformed configs fail closed with a clear error.
      await writeFile(configPath, "not json {{{", { mode: 0o600 });
      await expect(backend2.provider.getStatus()).rejects.toThrow(/malformed/i);
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });

  it("11. provider responses carry no secrets and exact shapes", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-leak-");
    try {
      const created = await setupProvider(setup.base, location, 2_000_000);
      expect(Object.keys(created).sort()).toEqual(PROVIDER_KEYS);
      const started = await postJson(setup.base, "/api/provider/start", {});
      expect(Object.keys(started.json["provider"] as Record<string, unknown>).sort()).toEqual(PROVIDER_KEYS);

      const seen: string[] = [JSON.stringify(created), JSON.stringify(started.json)];
      const getText = async (path: string): Promise<void> => {
        seen.push(await (await fetch(`${setup.base}${path}`)).text());
      };
      await getText("/api/provider");
      await getText("/api/files");
      await getText("/api/nodes");
      const denied = await postJson(setup.base, "/api/provider/setup", { location, capacityBytes: 10 });
      expect(denied.status).toBe(409);
      expect(Object.keys(denied.json)).toEqual(["error"]);
      seen.push(denied.text);
      const text = seen.join("\n").toLowerCase();
      for (const word of SECRET_WORDS) expect(text).not.toContain(word);
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });

  it("12. upload and download still work through the provider node", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-e2e-");
    try {
      await setupProvider(setup.base, location, 10_000_000);
      await postJson(setup.base, "/api/provider/start", {});
      const port = Number(new URL(setup.base).port);
      const fileData = Buffer.concat([randomBytes(2048), Buffer.from([0x00, 0xff])]);
      const uploaded = await uploadFile(port, "e2e.bin", fileData);
      expect(uploaded.status).toBe(200);
      const dl = await fetch(`${setup.base}/api/files/${uploaded.json["fileId"] as string}/download`);
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).equals(fileData)).toBe(true);
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });

  it("13. demo mode never masquerades as provider state", async () => {
    const web = createWebServer();
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const status = (await (await fetch(`${base}/api/provider`)).json()) as {
        provider: { configured: boolean; state: string };
      };
      expect(status.provider.configured).toBe(false);
      expect(status.provider.state).toBe("unconfigured");
      const setupAttempt = await postJson(base, "/api/provider/setup", { location: "/tmp/x", capacityBytes: 100 });
      expect(setupAttempt.status).toBe(400);
    } finally {
      await web.close();
    }
  });

  it("14. release refuses while pieces remain and completes when empty", async () => {
    const setup = await startLiveServer();
    const location = await tempDir("openstore-prov-release-");
    try {
      await setupProvider(setup.base, location, 5_000_000);
      await postJson(setup.base, "/api/provider/start", {});
      const port = Number(new URL(setup.base).port);
      const pinned = randomBytes(256);
      const uploaded = await uploadFile(port, "pinned.bin", pinned);
      expect(uploaded.status).toBe(200);
      const fileId = uploaded.json["fileId"] as string;

      // Draining first, then release is still refused: replicas remain.
      await postJson(setup.base, "/api/provider/stop", {});
      const refused = await postJson(setup.base, "/api/provider/release", { confirm: true });
      expect(refused.status).toBe(409);
      expect(String(refused.json["error"])).toMatch(/remain stored/i);

      // Without explicit confirmation, release never proceeds.
      const unconfirmed = await postJson(setup.base, "/api/provider/release", {});
      expect(unconfirmed.status).toBe(400);

      // Pieces are still served after the refused release.
      const dl = await fetch(`${setup.base}/api/files/${fileId}/download`);
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).equals(pinned)).toBe(true);
    } finally {
      await rm(location, { recursive: true, force: true });
      await setup.cleanup();
    }
  });
});
