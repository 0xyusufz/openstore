import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadIdentity } from "../../packages/identity/keystore.js";
import { generateFileId } from "../../packages/manifest/index.js";
import type { FileManifest } from "../../packages/manifest/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import type { ManifestStore } from "../../packages/manifest/store.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import type { StorageNodeEndpoint } from "./index.js";
import { uploadBuffer } from "./upload.js";
import { runCli, EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "./cli.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      out: (line: string) => stdout.push(line),
      err: (line: string) => stderr.push(line),
    },
  };
}

let nodeDir = "";
let node: StorageNode;
let endpoints: StorageNodeEndpoint[] = [];

beforeAll(async () => {
  nodeDir = await mkdtemp(join(tmpdir(), "openstore-cli-node-"));
  node = createStorageNode({ storageDir: nodeDir });
  const port = await node.listen(0, "127.0.0.1");
  endpoints = [{ id: "cli-node", baseUrl: `http://127.0.0.1:${port}` }];
});

afterAll(async () => {
  await node.close();
  await rm(nodeDir, { recursive: true, force: true });
});

describe("OpenStore CLI foundation (OPENSTORE-022)", () => {
  it("1. identity create works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-cli-id-"));
    try {
      const keystorePath = join(dir, "identity.json");
      const cap = capture();
      const code = await runCli(["identity", "create"], {
        ...cap.deps,
        keystorePath,
        password: "cli-test-password-022",
      });
      expect(code).toBe(EXIT_OK);
      const output = cap.stdout.join("\n");
      expect(output).toMatch(/identity created/i);
      expect(output).toMatch(/public key/i);
      expect(output).toMatch(/WARNING/i);
      expect(output).toMatch(/back up/i);
      // Keystore file decrypts with the password
      const identity = await loadIdentity("cli-test-password-022", keystorePath);
      expect(output).toContain(identity.publicKey.toString("base64"));
      // Phrase shown once for backup, but never persisted
      const phrase = identity.recoveryPhrase.join(" ");
      void phrase; // loaded identities never carry the phrase
      const stored = await readFile(keystorePath, "utf8");
      expect(stored.toLowerCase()).not.toContain("recoveryphrase");
      expect(stored).not.toContain(identity.privateKey.toString("base64"));
      // Missing password is a usage error
      const cap2 = capture();
      expect(await runCli(["identity", "create"], { ...cap2.deps, keystorePath: join(dir, "other.json") })).toBe(EXIT_USAGE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("2. files list shows safe metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-cli-list-"));
    try {
      const store = createManifestStore({ dir });
      const first = await uploadBuffer(Buffer.from("cli-list-one"), "one.txt", endpoints, { manifestStore: store });
      const second = await uploadBuffer(Buffer.from("cli-list-two"), "two.txt", endpoints, { manifestStore: store });
      const cap = capture();
      const code = await runCli(["files", "list"], { ...cap.deps, manifestDir: dir });
      expect(code).toBe(EXIT_OK);
      const output = cap.stdout.join("\n");
      expect(output).toContain(first.manifest.fileId);
      expect(output).toContain(second.manifest.fileId);
      expect(output).toContain("one.txt");
      expect(output).toContain("two.txt");
      // Empty store lists cleanly
      const emptyDir = await mkdtemp(join(tmpdir(), "openstore-cli-empty-"));
      try {
        const cap2 = capture();
        expect(await runCli(["files", "list"], { ...cap2.deps, manifestDir: emptyDir })).toBe(EXIT_OK);
        expect(cap2.stdout.join("\n")).toMatch(/no files/i);
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("3. files get works", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-cli-get-"));
    try {
      const store = createManifestStore({ dir });
      const { manifest } = await uploadBuffer(Buffer.from("cli-get-content"), "get.txt", endpoints, { manifestStore: store });
      const cap = capture();
      expect(await runCli(["files", "get", manifest.fileId], { ...cap.deps, manifestDir: dir })).toBe(EXIT_OK);
      const output = cap.stdout.join("\n");
      expect(output).toContain(manifest.fileId);
      expect(output).toContain("get.txt");
      expect(output).toContain(String(manifest.size));
      // Missing file is an operational failure, not a crash
      const cap2 = capture();
      expect(await runCli(["files", "get", generateFileId()], { ...cap2.deps, manifestDir: dir })).toBe(EXIT_FAILURE);
      expect(cap2.stderr.join("\n")).toMatch(/no file/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("4. delete without confirmation refuses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-cli-noconfirm-"));
    try {
      const store = createManifestStore({ dir });
      const { manifest } = await uploadBuffer(Buffer.from("cli-no-confirm"), "nc.txt", endpoints, { manifestStore: store });
      const cap = capture();
      const code = await runCli(["files", "delete", manifest.fileId], { ...cap.deps, manifestDir: dir });
      expect(code).toBe(EXIT_FAILURE);
      expect(cap.stderr.join("\n")).toMatch(/--yes/);
      // Nothing was deleted
      expect(await store.load(manifest.fileId)).toEqual(manifest);
      const pieceId = manifest.chunks[0]?.pieceId as string;
      expect((await fetch(`${endpoints[0]?.baseUrl}/pieces/${pieceId}`)).status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("5. delete with confirmation invokes existing deletion flow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-cli-del-"));
    try {
      const store = createManifestStore({ dir });
      const { manifest } = await uploadBuffer(Buffer.from("cli-delete-real"), "real.txt", endpoints, { manifestStore: store });

      // Spy: confirm the CLI delegates to the deletion flow with manifest + endpoints
      const seen: { fileId: string; endpoints: string[] }[] = [];
      const cap = capture();
      const code = await runCli(["files", "delete", manifest.fileId, "--yes", "--node", endpoints[0]?.baseUrl as string], {
        ...cap.deps,
        manifestDir: dir,
        deleteFileFn: (async (m: FileManifest, eps: StorageNodeEndpoint[], opts: { manifestStore?: ManifestStore }) => {
          seen.push({ fileId: m.fileId, endpoints: eps.map((e: StorageNodeEndpoint) => e.baseUrl) });
          const { deleteFile } = await import("./delete.js");
          return deleteFile(m, eps, opts);
        }),
      });
      expect(code).toBe(EXIT_OK);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.fileId).toBe(manifest.fileId);
      expect(seen[0]?.endpoints).toEqual([endpoints[0]?.baseUrl]);
      expect(cap.stdout.join("\n")).toMatch(/deleted/i);
      // Real flow ran: pieces gone from the node, manifest removed
      const pieceId = manifest.chunks[0]?.pieceId as string;
      expect((await fetch(`${endpoints[0]?.baseUrl}/pieces/${pieceId}`)).status).toBe(404);
      expect(await store.load(manifest.fileId)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("6. invalid command/fileId returns non-zero failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-cli-invalid-"));
    try {
      const cap = capture();
      expect(await runCli(["frobnicate"], { ...cap.deps, manifestDir: dir })).toBe(EXIT_USAGE);
      const cap2 = capture();
      expect(await runCli(["files", "get", "../evil"], { ...cap2.deps, manifestDir: dir })).toBe(EXIT_USAGE);
      const cap3 = capture();
      expect(await runCli(["files", "delete", "../../x", "--yes"], { ...cap3.deps, manifestDir: dir })).toBe(EXIT_USAGE);
      const cap4 = capture();
      expect(await runCli([], { ...cap4.deps, manifestDir: dir })).toBe(EXIT_OK); // help
      const cap5 = capture();
      expect(await runCli(["files", "delete", generateFileId()], { ...cap5.deps, manifestDir: dir })).toBe(EXIT_FAILURE); // no --yes
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("7. secrets never appear in CLI output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openstore-cli-secrets-"));
    try {
      // Identity material for negative checks
      const keystorePath = join(dir, "identity.json");
      const capId = capture();
      await runCli(["identity", "create"], { ...capId.deps, keystorePath, password: "secret-cli-pw-022" });
      const identityOut = capId.stdout.join("\n");
      const identity = await loadIdentity("secret-cli-pw-022", keystorePath);
      expect(identityOut).not.toContain(identity.privateKey.toString("base64"));
      expect(identityOut).not.toContain(identity.privateKey.toString("hex"));
      expect(identityOut).not.toContain("secret-cli-pw-022");

      // File commands must not leak plaintext, keys, or phrase words
      const store = createManifestStore({ dir: join(dir, "manifests") });
      const secret = Buffer.from("cli-plaintext-must-not-leak");
      const { manifest, encryptionKey } = await uploadBuffer(secret, "s.txt", endpoints, { manifestStore: store });
      const allOut: string[] = [];
      const collect = { out: (l: string) => allOut.push(l), err: (l: string) => allOut.push(l) };
      await runCli(["files", "list"], { ...collect, manifestDir: join(dir, "manifests") });
      await runCli(["files", "get", manifest.fileId], { ...collect, manifestDir: join(dir, "manifests") });
      await runCli(["files", "delete", manifest.fileId], { ...collect, manifestDir: join(dir, "manifests") });
      const text = allOut.join("\n");
      expect(text).not.toContain("cli-plaintext-must-not-leak");
      expect(text).not.toContain(secret.toString("base64"));
      expect(text).not.toContain(Buffer.from(encryptionKey).toString("base64"));
      expect(text).not.toContain(Buffer.from(encryptionKey).toString("hex"));
      expect(text).not.toContain(identity.privateKey.toString("base64"));
      expect(text).not.toContain("secret-cli-pw-022");
      expect(text.toLowerCase()).not.toContain("privatekey");
      expect(text.toLowerCase()).not.toContain("encryptionkey");
      expect(text.toLowerCase()).not.toContain("recoveryphrase");
      void writeFile;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
