import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createIdentity } from "../../packages/identity/index.js";
import { CRYPTO_VERSION } from "../../packages/crypto/index.js";
import { buildManifest, generateFileId } from "../../packages/manifest/index.js";
import type { FileManifest } from "../../packages/manifest/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createRegistry } from "../../packages/registry/index.js";
import { MOCK_FILES } from "./src/mock.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { uploadBuffer } from "../client/upload.js";
import { createWebBackend } from "./backend.js";
import { createWebServer } from "./server.js";
import type { WebServer } from "./server.js";

function makeManifest(fileId: string, filename: string): FileManifest {
  return buildManifest({
    fileId,
    filename,
    size: 7,
    chunkSize: 7,
    cryptoVersion: CRYPTO_VERSION,
    chunks: [
      {
        index: 0,
        pieceId: randomBytes(32).toString("hex"),
        plaintextHash: randomBytes(32).toString("hex"),
        plaintextSize: 7,
        encryptedSize: 120,
        nodeIds: ["node-a"],
      },
    ],
  });
}

const FILE_KEYS = ["fileId", "filename", "size", "totalChunks", "chunkSize", "createdAt"];
const NODE_KEYS = [
  "id",
  "baseUrl",
  "available",
  "allocatedBytes",
  "usedBytes",
  "availableBytes",
  "score",
  "storageScore",
  "lastSeen",
];

describe("web backend integration (OPENSTORE-024)", () => {
  it("1. real manifest metadata appears through the web backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-web-backend-"));
    try {
      const store = createManifestStore({ dir });
      const first = await store.save(makeManifest(generateFileId(), "live-one.txt"));
      const second = await store.save(makeManifest(generateFileId(), "live-two.txt"));

      const backend = createWebBackend({ manifestDir: dir });
      expect(backend.status.manifestStore).toBe(true);
      const snapshot = await backend.getSnapshot();
      expect(snapshot.filesSource).toBe("live");
      const byId = new Map(snapshot.files.map((f) => [f.fileId, f]));
      expect(byId.get(first.fileId)?.filename).toBe("live-one.txt");
      expect(byId.get(second.fileId)?.filename).toBe("live-two.txt");
      expect(byId.get(first.fileId)?.size).toBe(first.size);
      for (const file of snapshot.files) {
        expect(Object.keys(file).sort()).toEqual([...FILE_KEYS].sort());
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. real node metadata appears safely", async () => {
    const registry = createRegistry();
    const a = createIdentity();
    const b = createIdentity();
    registry.register("http://127.0.0.1:4301", a, {
      allocatedBytes: 1000,
      totalBytes: 1000,
      usedBytes: 200,
      availableBytes: 800,
    });
    registry.register("http://127.0.0.1:4302", b);

    const backend = createWebBackend({ registry });
    expect(backend.status.registry).toBe(true);
    const snapshot = await backend.getSnapshot();
    expect(snapshot.nodesSource).toBe("live");
    expect(snapshot.nodes).toHaveLength(2);
    const byUrl = new Map(snapshot.nodes.map((n) => [n.baseUrl, n]));
    expect(byUrl.get("http://127.0.0.1:4301")?.availableBytes).toBe(800);
    expect(byUrl.get("http://127.0.0.1:4301")?.score).toBe(50);
    for (const node of snapshot.nodes) {
      expect(Object.keys(node).sort()).toEqual([...NODE_KEYS].sort());
    }
    const text = JSON.stringify(snapshot.nodes);
    expect(text).not.toContain(a.privateKey.toString("base64"));
    expect(text.toLowerCase()).not.toContain("privatekey");
    expect(text.toLowerCase()).not.toContain("signature");
  });

  it("3. browser-facing responses contain no secrets", async () => {
    const nodeDir = await mkdtemp(join(tmpdir(), "openstore-web-int-node-"));
    const storeDir = await mkdtemp(join(tmpdir(), "openstore-web-int-store-"));
    let node: StorageNode | undefined;
    let web: WebServer | undefined;
    try {
      node = createStorageNode({ storageDir: nodeDir });
      const port = await node.listen(0, "127.0.0.1");
      const endpoints = [{ id: "web-int-node", baseUrl: `http://127.0.0.1:${port}` }];
      const store = createManifestStore({ dir: storeDir });
      const secret = Buffer.from("web-backend-secret-plaintext");
      const { manifest, encryptionKey } = await uploadBuffer(secret, "web-secret.txt", endpoints, {
        manifestStore: store,
      });

      const registry = createRegistry();
      const nodeId = createIdentity();
      registry.register(`http://127.0.0.1:${port}`, nodeId, {
        allocatedBytes: 1_000_000,
        totalBytes: 1_000_000,
        usedBytes: secret.length,
        availableBytes: 1_000_000 - secret.length,
      });

      web = createWebServer({ manifestDir: storeDir, registry });
      const webPort = await web.listen(0, "127.0.0.1");
      const base = `http://127.0.0.1:${webPort}`;

      const keyB64 = Buffer.from(encryptionKey).toString("base64");
      const keyHex = Buffer.from(encryptionKey).toString("hex");
      for (const path of ["/api/files", "/api/nodes", "/api/identity", "/health", "/api/health"]) {
        const res = await fetch(`${base}${path}`);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain("web-backend-secret-plaintext");
        expect(text).not.toContain(secret.toString("base64"));
        expect(text).not.toContain(keyB64);
        expect(text).not.toContain(keyHex);
        expect(text).not.toContain(nodeId.privateKey.toString("base64"));
        expect(text.toLowerCase()).not.toContain("privatekey");
        expect(text.toLowerCase()).not.toContain("recoveryphrase");
        expect(text.toLowerCase()).not.toContain("encryptionkey");
        expect(text.toLowerCase()).not.toContain("password");
      }

      const filesJson = (await (await fetch(`${base}/api/files`)).json()) as {
        files: Record<string, unknown>[];
        source: string;
      };
      expect(filesJson.source).toBe("live");
      expect(filesJson.files.map((f) => f["fileId"])).toContain(manifest.fileId);
      for (const file of filesJson.files) {
        expect(Object.keys(file).sort()).toEqual([...FILE_KEYS].sort());
      }
      const nodesJson = (await (await fetch(`${base}/api/nodes`)).json()) as {
        nodes: Record<string, unknown>[];
        source: string;
      };
      expect(nodesJson.source).toBe("live");
      for (const n of nodesJson.nodes) {
        expect(Object.keys(n).sort()).toEqual([...NODE_KEYS].sort());
      }
    } finally {
      await web?.close();
      await node?.close();
      await rm(nodeDir, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  it("4. demo fallback still works", async () => {
    const backend = createWebBackend();
    expect(backend.status.demoMode).toBe(true);
    const snapshot = await backend.getSnapshot();
    expect(snapshot.filesSource).toBe("demo");
    expect(snapshot.nodesSource).toBe("demo");
    expect(snapshot.files).toEqual(MOCK_FILES);

    const web = createWebServer();
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const files = (await (await fetch(`${base}/api/files`)).json()) as { source: string };
      expect(files.source).toBe("demo");
      const health = (await (await fetch(`${base}/health`)).json()) as { demoMode: boolean };
      expect(health.demoMode).toBe(true);
    } finally {
      await web.close();
    }
  });

  it("5. health endpoint works", async () => {
    const web = createWebServer({ identityLabel: "demo-label" });
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      for (const path of ["/health", "/api/health"]) {
        const res = await fetch(`${base}${path}`);
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          status: string;
          app: string;
          demoMode: boolean;
          backend: { demoMode: boolean; manifestStore: boolean; registry: boolean };
        };
        expect(json.status).toBe("ok");
        expect(json.app).toBe("openstore-web");
        expect(typeof json.demoMode).toBe("boolean");
        expect(typeof json.backend.manifestStore).toBe("boolean");
        expect(typeof json.backend.registry).toBe("boolean");
      }
      const identity = (await (await fetch(`${base}/api/identity`)).json()) as {
        identity: { configured: boolean; label: string };
      };
      expect(identity.identity.configured).toBe(true);
      expect(identity.identity.label).toBe("demo-label");
    } finally {
      await web.close();
    }
  });

  it("6. invalid requests return safe errors", async () => {
    const web = createWebServer();
    const port = await web.listen(0, "127.0.0.1");
    try {
      const base = `http://127.0.0.1:${port}`;
      const missing = await fetch(`${base}/api/no-such-endpoint`);
      expect(missing.status).toBe(404);
      expect(Object.keys(await missing.json())).toEqual(["error"]);

      const wrongMethod = await fetch(`${base}/api/files`, { method: "POST" });
      expect(wrongMethod.status).toBe(405);
      expect(Object.keys(await wrongMethod.json())).toEqual(["error"]);

      // Backend option validation fails fast with clear errors
      expect(() => createWebBackend({ manifestDir: "" })).toThrow(/manifestDir/i);
      expect(() => createWebBackend(null as never)).toThrow(/object/i);
    } finally {
      await web.close();
    }
  });
});

describe("web backend snapshot state", () => {
  it("applies live snapshots and clears demo mode", async () => {
    const { createInitialState, applyBackendSnapshot } = await import("./src/store.js");
    const { MOCK_FILES: demoFiles } = await import("./src/mock.js");
    const before = createInitialState();
    expect(before.demoMode).toBe(true);

    const liveFile = { ...demoFiles[0]!, fileId: "live-file-1", filename: "live.txt" };
    const after = applyBackendSnapshot(before, {
      files: [liveFile],
      nodes: [],
      identity: { configured: true, unlocked: true, label: "op:abc" },
      filesSource: "live",
      nodesSource: "live",
    });
    expect(after.demoMode).toBe(false);
    expect(after.files).toEqual([liveFile]);
    expect(after.identity.configured).toBe(true);
    // Source state object untouched (copies taken)
    expect(before.files).not.toBe(after.files);

    // Demo snapshots keep demo mode
    const demo = applyBackendSnapshot(before, {
      files: [],
      nodes: [],
      identity: { configured: false, unlocked: false, label: "demo" },
      filesSource: "demo",
      nodesSource: "demo",
    });
    expect(demo.demoMode).toBe(true);

    // Malformed snapshots rejected clearly
    expect(() => applyBackendSnapshot(before, null as never)).toThrow(/object/i);
    expect(() => applyBackendSnapshot(before, { files: "x" } as never)).toThrow(/arrays/i);
  });
});
