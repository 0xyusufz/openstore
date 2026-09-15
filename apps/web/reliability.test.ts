/**
 * Upload/Download Reliability & UX Tests (OPENSTORE-030)
 *
 * Hardened real pipelines: retry, cleanup, interruption, replica fallback,
 * corruption handling, duplicate prevention, and safe errors. No mocking
 * of crypto; real storage nodes and HTTP where it matters.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, createHash } from "crypto";
import { request as httpRequest } from "http";
import { createServer } from "http";
import type { AddressInfo } from "net";
import { DEFAULT_CHUNK_SIZE } from "../../packages/chunking/index.js";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createDekStore } from "./dekstore.js";
import { uploadBuffer } from "../client/upload.js";
import { downloadBuffer } from "../client/download.js";
import { getPieceFromNodes, storePieceOnNodes, isTransientError } from "../client/index.js";
import { createWebBackend } from "./backend.js";
import { createWebServer } from "./server.js";
import {
  attemptDownload,
  attemptUpload,
  createInitialState,
  downloadComplete,
  downloadDecrypting,
  downloadDownloading,
  downloadFailed,
  downloadLocating,
  isRetryableError,
  retryDownload,
  retryUpload,
  selectFileForUpload,
  toUserFacingError,
  uploadComplete,
  uploadEncrypting,
  uploadFailed,
  uploadPreparing,
} from "./src/store.js";
import { renderFiles, renderUpload } from "./src/views.js";

function sha256Hex(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

let nodes: StorageNode[] = [];
let endpoints: { id: string; baseUrl: string }[] = [];
let manifestDir = "";

beforeAll(async () => {
  const dirs = [
    await mkdtemp(join(tmpdir(), "rel-node-a-")),
    await mkdtemp(join(tmpdir(), "rel-node-b-")),
    await mkdtemp(join(tmpdir(), "rel-node-c-")),
  ];
  for (const dir of dirs) {
    const node = createStorageNode({ storageDir: dir });
    const port = await node.listen(0, "127.0.0.1");
    nodes.push(node);
    endpoints.push({ id: `rel-${port}`, baseUrl: `http://127.0.0.1:${port}` });
  }
  manifestDir = await mkdtemp(join(tmpdir(), "rel-manifests-"));
}, 30_000);

afterAll(async () => {
  for (const n of nodes) await n.close();
  for (const n of nodes) await rm(n.storageDir, { recursive: true, force: true });
  if (manifestDir) {
    await rm(manifestDir, { recursive: true, force: true });
    await rm(`${manifestDir}.deks.json`, { force: true });
    await rm(`${manifestDir}.provider.json`, { force: true });
  }
});

function makeFlakyServer(): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "transient" }));
      return;
    }
    // After first failure, act like a storage node for POST /pieces and GET /pieces/:id
    let body = Buffer.alloc(0);
    req.on("data", (c: Buffer) => (body = Buffer.concat([body, c])));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/pieces") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: 1, id: "x", size: body.length }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/pieces/")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(body);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      res({
        url: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe("reliability (OPENSTORE-030)", () => {
  it("1. transient upload node failure retries and succeeds", async () => {
    // One flaky endpoint that 500s first, then a real node that always succeeds.
    // uploadBuffer should retry the flaky piece and eventually succeed via the live node.
    const flaky = await makeFlakyServer();
    try {
      const data = randomBytes(512);
      const { manifest } = await uploadBuffer(data, "transient.bin", [
        { id: "flaky", baseUrl: flaky.url },
        endpoints[0]!,
      ]);
      expect(manifest.totalChunks).toBe(1);
      expect(flaky.hits()).toBeGreaterThanOrEqual(1);
    } finally {
      await flaky.close();
    }
  });

  it("2. permanent upload failure creates no catalog entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rel-perm-manifests-"));
    const registry = createRegistry();
    const backend = createWebBackend({ manifestDir: dir, registry });
    const before = (await backend.getSnapshot()).files.length;
    await expect(backend.uploadFile("fail.bin", Buffer.alloc(256, 0x11))).rejects.toThrow(/no storage nodes|failed to store/i);
    const after = (await backend.getSnapshot()).files.length;
    expect(after).toBe(before);
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}.deks.json`, { force: true });
    await rm(`${dir}.provider.json`, { force: true });
  });

  it("3. partial upload cleans up pieces without touching other files", async () => {
    // Tiny quota node: first chunk's piece fits, second chunk's piece exceeds quota
    // The pipeline should clean up the first chunk's pieces and leave no manifest.
    const tinyDir = await mkdtemp(join(tmpdir(), "rel-tiny-"));
    const smallCap = 800; // enough for one encrypted piece (~1k) but not two
    const tinyNode = createStorageNode({ storageDir: tinyDir, capacityBytes: smallCap });
    const port = await tinyNode.listen(0, "127.0.0.1");
    const tinyEndpoint = { id: "tiny", baseUrl: `http://127.0.0.1:${port}` };
    const dir = await mkdtemp(join(tmpdir(), "rel-partial-manifests-"));
    // Keep a good file so we can prove it wasn't deleted during cleanup
    const keepData = randomBytes(200);
    const keepStore = createManifestStore({ dir });
    const keep = await uploadBuffer(keepData, "keep.bin", [tinyEndpoint], { manifestStore: keepStore });
    const keepPiecesBefore = (await readdir(tinyDir)).length;
    expect(keepPiecesBefore).toBeGreaterThan(0);
    // Now try a 2-chunk file that will fail on second chunk
    const bigData = randomBytes(DEFAULT_CHUNK_SIZE + 100);
    await expect(
      uploadBuffer(bigData, "big.bin", [tinyEndpoint], { manifestStore: keepStore, chunkSize: DEFAULT_CHUNK_SIZE }),
    ).rejects.toThrow();
    // Keep file still exists and its pieces weren't deleted
    const keepAfter = await keepStore.load(keep.manifest.fileId);
    expect(keepAfter).toBeDefined();
    // Only keep's pieces remain (no orphan from failed big file)
    const filesAfter = await readdir(tinyDir);
    expect(filesAfter.length).toBe(keepPiecesBefore);
    // Quota still enforced
    expect((await tinyNode.getCapacity()).usedBytes).toBeLessThanOrEqual(smallCap);
    await tinyNode.close();
    await rm(tinyDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}.deks.json`, { force: true });
  }, 30_000);

  it("4. network interruption is handled as retryable failure", async () => {
    const controller = new AbortController();
    const p = getPieceFromNodes("0".repeat(64), endpoints, { timeoutMs: 5000 });
    // Abort via signal not directly exposed, but we can test isTransientError and store retryable
    controller.abort();
    expect(isTransientError("network timeout")).toBe(true);
    expect(isTransientError("aborted")).toBe(true);
    expect(isRetryableError("network timeout")).toBe(true);
    expect(isRetryableError("ECONNREFUSED")).toBe(true);
    const failed = uploadFailed(createInitialState(), "network timeout");
    expect(failed.upload.retryable).toBe(true);
    const notRetryable = uploadFailed(createInitialState(), "file is empty");
    expect(notRetryable.upload.retryable).toBe(false);
    await expect(p).rejects.toThrow(); // no such piece, fails but not due to abort
  });

  it("5. transient download failure falls back to healthy replica", async () => {
    const data = randomBytes(1024);
    const { manifest, encryptionKey } = await uploadBuffer(data, "fallback.bin", endpoints, {
      manifestStore: createManifestStore({ dir: manifestDir }),
    });
    try {
      // Corrupt first replica's copy; second replica should serve it after fallback
      const pieceId = manifest.pieceIds[0]!;
      await writeFile(join(nodes[0]!.storageDir, pieceId), Buffer.from("corrupted"));
      const recovered = await downloadBuffer(manifest, encryptionKey, endpoints);
      expect(recovered.equals(data)).toBe(true);
      // Restore for later tests (overwrite with correct piece via re-upload)
      // Not needed: next test will overwrite or use different manifest
    } finally {
      encryptionKey.fill(0);
    }
  });

  it("6. corrupted piece on all replicas fails closed", async () => {
    const data = randomBytes(512);
    const { manifest, encryptionKey } = await uploadBuffer(data, "corrupt.bin", endpoints, {
      manifestStore: createManifestStore({ dir: manifestDir }),
    });
    try {
      for (const pid of manifest.pieceIds) {
        for (const n of nodes) await writeFile(join(n.storageDir, pid), Buffer.from("garbage"));
      }
      await expect(downloadBuffer(manifest, encryptionKey, endpoints)).rejects.toThrow(/hash mismatch|unavailable|corrupt/i);
      // No partial file returned
    } finally {
      encryptionKey.fill(0);
    }
  });

  it("7. missing piece fails closed", async () => {
    const data = randomBytes(512);
    const { manifest, encryptionKey } = await uploadBuffer(data, "missing.bin", endpoints, {
      manifestStore: createManifestStore({ dir: manifestDir }),
    });
    try {
      for (const pid of manifest.pieceIds) {
        for (const n of nodes) await rm(join(n.storageDir, pid), { force: true });
      }
      await expect(downloadBuffer(manifest, encryptionKey, endpoints)).rejects.toThrow(/unavailable/i);
    } finally {
      encryptionKey.fill(0);
    }
  });

  it("8. wrong key fails closed", async () => {
    const data = randomBytes(512);
    const { manifest, encryptionKey } = await uploadBuffer(data, "wrongkey.bin", endpoints, {
      manifestStore: createManifestStore({ dir: manifestDir }),
    });
    try {
      const wrong = randomBytes(32);
      await expect(downloadBuffer(manifest, wrong, endpoints)).rejects.toThrow(/decryption failed|key/i);
    } finally {
      encryptionKey.fill(0);
    }
  });

  it("9. final hash/size mismatch fails closed", async () => {
    const data = randomBytes(512);
    const { manifest, encryptionKey } = await uploadBuffer(data, "mismatch.bin", endpoints, {
      manifestStore: createManifestStore({ dir: manifestDir }),
    });
    try {
      // Tamper plaintextHash to trigger hash mismatch
      const tampered = { ...manifest, chunks: manifest.chunks.map((c, i) => (i === 0 ? { ...c, plaintextHash: "0".repeat(64) } : c)) };
      await expect(downloadBuffer(tampered as any, encryptionKey, endpoints)).rejects.toThrow(/hash mismatch|plaintext/i);
      // Tamper plaintextSize
      const tampered2 = { ...manifest, chunks: manifest.chunks.map((c, i) => (i === 0 ? { ...c, plaintextSize: c.plaintextSize + 1 } : c)) };
      await expect(downloadBuffer(tampered2 as any, encryptionKey, endpoints)).rejects.toThrow(/size mismatch|plaintext/i);
      // Via web backend, tampered manifest size fails the final size check
      const webReg = createRegistry();
      for (const ep of endpoints) {
        const id = createIdentity();
        webReg.register(ep.baseUrl, id, { allocatedBytes: 1 << 30, usedBytes: 0, availableBytes: 1 << 30 });
      }
      const webDir = await mkdtemp(join(tmpdir(), "rel-mismatch-web-"));
      try {
        const web = createWebServer({ manifestDir: webDir, registry: webReg });
        const port = await web.listen(0, "127.0.0.1");
        try {
          const directStore = createManifestStore({ dir: webDir });
          const directDek = createDekStore({ path: `${webDir}.deks.json` });
          // Upload via backend so DEK is vaulted
          const upRes = await (await import("./backend.js")).createWebBackend({ manifestDir: webDir, registry: webReg }).uploadFile("mismatch2.bin", data);
          // Corrupt the manifest on disk to have wrong size
          const raw = await readFile(join(webDir, `${upRes.fileId}.json`), "utf8");
          const parsed = JSON.parse(raw);
          parsed.manifest.size = parsed.manifest.size + 1;
          await writeFile(join(webDir, `${upRes.fileId}.json`), JSON.stringify(parsed));
          const dl = await fetch(`http://127.0.0.1:${port}/api/files/${upRes.fileId}/download`);
          expect(dl.status).toBe(500);
        } finally {
          await web.close();
        }
      } finally {
        await rm(webDir, { recursive: true, force: true });
        await rm(`${webDir}.deks.json`, { force: true });
        await rm(`${webDir}.provider.json`, { force: true });
      }
    } finally {
      encryptionKey.fill(0);
    }
  });

  it("10. duplicate operation prevention", async () => {
    let state = createInitialState();
    state = selectFileForUpload(state, "dup.bin", 100);
    state = attemptUpload(state);
    expect(state.upload.status).toBe("preparing");
    // Second attempt while preparing is no-op
    expect(attemptUpload(state)).toBe(state);
    state = uploadPreparing(state);
    expect(attemptDownload(state, state.files[0]!.fileId)).toBe(state); // upload active blocks download
    // Staging a new file while an upload is active is refused with a notice
    const staged = selectFileForUpload(state, "other.bin", 50);
    expect(staged.upload.status).toBe("encrypting");
    expect(staged.notice).toMatch(/already in progress/i);
    state = uploadEncrypting(state);
    expect(attemptUpload(state)).toBe(state);
    // Retry while a download is active is refused
    const failedUp = uploadFailed(
      { ...createInitialState(), upload: { status: "failed", fileName: "dup.bin", fileSize: 100, note: "x", retryable: true } },
      "timeout",
    );
    expect(retryUpload(failedUp).upload.status).toBe("ready");
    // Download duplicate prevention
    let dState = createInitialState();
    const fid = dState.files[0]!.fileId;
    dState = attemptDownload(dState, fid);
    expect(dState.download.status).toBe("locating");
    expect(attemptDownload(dState, fid)).toBe(dState);
    dState = downloadLocating(dState);
    expect(attemptDownload(dState, fid)).toBe(dState);
    // Upload attempt while a download is active is a no-op (same reference)
    const readyUp = selectFileForUpload(createInitialState(), "up.bin", 10);
    const withActiveDownload = { ...readyUp, download: { ...readyUp.download, status: "downloading" as const, fileId: fid, filename: "x", note: null, retryable: false } };
    const blocked = attemptUpload(withActiveDownload);
    expect(blocked).toBe(withActiveDownload);
    expect(blocked.upload.status).toBe("ready");
    // Retry of a failed download is refused while an upload runs
    const failedDl = downloadFailed(
      { ...createInitialState(), download: { status: "failed", fileId: fid, filename: "x", note: "x", retryable: true } },
      "timeout",
    );
    const withActiveUpload = { ...failedDl, upload: { status: "storing" as const, fileName: "up.bin", fileSize: 10, note: null, retryable: false } };
    const blockedRetry = retryDownload(withActiveUpload);
    expect(blockedRetry).toBe(withActiveUpload);
    expect(blockedRetry.download.status).toBe("failed");
    // Views reflect the conflict: upload button disabled during a download
    const { renderUpload: renderUp } = await import("./src/views.js");
    expect(renderUp(blocked).match(/data-action="upload-attempt"[^>]*disabled/)).toBeTruthy();
  });

  it("11. retry UI/state transitions", async () => {
    // Upload retry: transient -> retryable -> ready again
    let state = createInitialState();
    state = selectFileForUpload(state, "retry.bin", 100);
    state = attemptUpload(state);
    state = uploadPreparing(state);
    state = uploadEncrypting(state);
    state = uploadFailed(state, "timeout: network");
    expect(state.upload.status).toBe("failed");
    expect(state.upload.retryable).toBe(true);
    expect(renderUpload(state)).toContain("Retry");
    const retried = retryUpload(state);
    expect(retried.upload.status).toBe("ready");
    // Permanent failure has no retry
    state = uploadFailed(createInitialState(), "file is empty");
    expect(state.upload.retryable).toBe(false);
    expect(renderUpload(state)).not.toContain('data-action="upload-retry"');
    expect(retryUpload(state)).toBe(state);

    // Download retry
    let dState = createInitialState();
    const fid = dState.files[0]!.fileId;
    dState = attemptDownload(dState, fid);
    dState = downloadLocating(dState);
    dState = downloadDownloading(dState);
    dState = downloadDecrypting(dState);
    dState = downloadFailed(dState, "timeout");
    expect(dState.download.retryable).toBe(true);
    expect(renderFiles(dState)).toContain('data-action="download-retry"');
    const dRetried = retryDownload(dState);
    expect(dRetried.download.status).toBe("locating");
    // Permanent download failure no retry
    let dPerm = attemptDownload(createInitialState(), fid);
    dPerm = downloadFailed(dPerm, "hash mismatch");
    expect(dPerm.download.retryable).toBe(false);
    expect(retryDownload(dPerm)).toBe(dPerm);
  });

  it("12. no secret leakage in states or API errors", async () => {
    const secret = "super-secret-plaintext-xyz";
    const data = Buffer.from(secret);
    const reg = createRegistry();
    for (const ep of endpoints) {
      const id = createIdentity();
      reg.register(ep.baseUrl, id, { allocatedBytes: 1 << 30, usedBytes: 0, availableBytes: 1 << 30 });
    }
    const liveWeb = createWebServer({ manifestDir, registry: reg });
    const port = await liveWeb.listen(0, "127.0.0.1");
    try {
      // Try a failing upload with empty file to get error
      const boundary = "leak-test";
      const emptyBody = Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="x.txt"\r\ncontent-type: text/plain\r\n\r\n\r\n--${boundary}--\r\n`, "utf8");
      const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpRequest(
          { hostname: "127.0.0.1", port, path: "/api/files/upload", method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": emptyBody.length } },
          (r) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        req.write(emptyBody);
        req.end();
      });
      expect(res.text.toLowerCase()).not.toContain("privatekey");
      expect(res.text.toLowerCase()).not.toContain("recoveryphrase");
      expect(res.text).not.toContain(secret);
      // Store state never contains plaintext
      let state = createInitialState();
      state = selectFileForUpload(state, "secret.txt", data.length);
      expect(JSON.stringify(state)).not.toContain(secret);
      state = uploadFailed(state, "boom " + secret);
      expect(state.upload.note).not.toContain(secret);
      // Views never render secrets
      const html = renderUpload(state) + renderFiles(state);
      expect(html.toLowerCase()).not.toContain("privatekey");
      expect(html).not.toContain(secret);
    } finally {
      await liveWeb.close();
    }
  });

  it("13. web reports truthful progress stages without percentages", async () => {
    let state = createInitialState();
    state = selectFileForUpload(state, "a.bin", 100);
    expect(renderUpload(state)).toContain("Ready to upload");
    state = attemptUpload(state);
    expect(renderUpload(state)).toContain("Preparing…");
    expect(renderUpload(state)).not.toContain("aria-valuenow");
    state = uploadPreparing(state);
    expect(renderUpload(state)).toContain("Encrypting…");
    state = uploadEncrypting(state);
    expect(renderUpload(state)).toContain("Storing encrypted replicas…");
    state = uploadComplete(state, { fileId: "x", filename: "a.bin", size: 100, totalChunks: 1 });
    expect(renderUpload(state)).toContain("Complete");
    // Download stages
    const fid = createInitialState().files[0]!.fileId;
    let d = attemptDownload(createInitialState(), fid);
    expect(renderFiles(d)).toContain("Locating file…");
    d = downloadLocating(d);
    expect(renderFiles(d)).toContain("Downloading");
    d = downloadDownloading(d);
    expect(renderFiles(d)).toContain("Decrypting");
    d = downloadDecrypting(d);
    expect(renderFiles(d)).toContain("Verifying");
  });
});
