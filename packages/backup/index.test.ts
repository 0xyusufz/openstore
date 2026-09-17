import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createBackup, restoreBackup, verifyBackup } from "./index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openstore-backup-"));
  const client = join(root, "client");
  const manifests = join(client, "manifests");
  const operations = join(client, "operations");
  const pieces = join(root, "pieces");
  await mkdir(manifests, { recursive: true });
  await mkdir(operations, { recursive: true });
  await mkdir(join(pieces, ".provenance"), { recursive: true });
  await writeFile(join(client, "keystore.json"), Buffer.from('{"encryptedPrivateKey":"opaque"}'), { mode: 0o600 });
  await writeFile(join(manifests, "file-1.json"), Buffer.from('{"manifest":"opaque"}'), { mode: 0o600 });
  await writeFile(join(operations, "op-1.json"), Buffer.from('{"state":"verified"}'), { mode: 0o600 });
  await writeFile(join(client, "vault.deks.json"), Buffer.from('{"version":1,"deks":{"file-1":"opaque"}}'), { mode: 0o600 });
  await writeFile(join(pieces, "piece-1"), Buffer.from("encrypted-piece"), { mode: 0o600 });
  await writeFile(join(pieces, ".provenance", "piece-1.json"), Buffer.from('{"version":2,"claims":[]}'), { mode: 0o600 });
  await writeFile(join(root, "registry.json"), Buffer.from('{"version":1,"nodes":[]}'), { mode: 0o600 });
  return { root, client, manifests, operations, pieces, registry: join(root, "registry.json"), keystore: join(client, "keystore.json") };
}

describe("backup and recovery foundation", () => {
  it("backs up client, coordinator, and storage-node state with checksums", async () => {
    const f = await fixture();
    const backup = join(f.root, "backup");
    const inventory = await createBackup({
      destination: backup,
      sources: {
        client: { keystorePath: f.keystore, manifestDir: f.manifests, operationDir: f.operations, dekPath: join(f.client, "vault.deks.json") },
        coordinator: { registryPath: f.registry },
        storageNode: { identityPath: f.keystore, storageDir: f.pieces },
      },
    });
    expect(inventory.components).toEqual(["client", "coordinator", "storage-node"]);
    expect(inventory.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    expect((await verifyBackup(backup)).valid).toBe(true);
    await rm(f.root, { recursive: true, force: true });
  });

  it("detects corruption, missing files, and unexpected files", async () => {
    const f = await fixture();
    const backup = join(f.root, "backup");
    await createBackup({ destination: backup, sources: { coordinator: { registryPath: f.registry } } });
    await writeFile(join(backup, "data", "coordinator", "registry"), "tampered");
    await writeFile(join(backup, "data", "unexpected"), "unexpected");
    const report = await verifyBackup(backup);
    expect(report.valid).toBe(false);
    expect(report.corrupt).toContain("coordinator/registry");
    expect(report.extra).toContain("unexpected");
    await rm(f.root, { recursive: true, force: true });
  });

  it("rejects missing files and unsafe symlink sources", async () => {
    const f = await fixture();
    const backup = join(f.root, "backup");
    await createBackup({ destination: backup, sources: { coordinator: { registryPath: f.registry } } });
    await rm(join(backup, "data", "coordinator", "registry"));
    expect((await verifyBackup(backup)).missing).toContain("coordinator/registry");
    const link = join(f.root, "link");
    await symlink(f.registry, link);
    await expect(createBackup({ destination: join(f.root, "bad"), sources: { coordinator: { registryPath: link } } })).rejects.toThrow(/symlink/);
    await rm(f.root, { recursive: true, force: true });
  });

  it("refuses an existing destination and a destination inside a source", async () => {
    const f = await fixture();
    const backup = join(f.root, "backup");
    await createBackup({ destination: backup, sources: { coordinator: { registryPath: f.registry } } });
    await expect(createBackup({ destination: backup, sources: { coordinator: { registryPath: f.registry } } })).rejects.toThrow(/already exists/);
    await expect(createBackup({ destination: join(f.pieces, "backup"), sources: { storageNode: { identityPath: f.keystore, storageDir: f.pieces } } })).rejects.toThrow(/inside/);
    await rm(f.root, { recursive: true, force: true });
  });

  it("restores into an empty destination with restrictive file permissions", async () => {
    const f = await fixture();
    const backup = join(f.root, "backup");
    const destination = join(f.root, "restored");
    await createBackup({ destination: backup, sources: { storageNode: { identityPath: f.keystore, storageDir: f.pieces } } });
    await restoreBackup({ backupDir: backup, destination });
    expect(await readFile(join(destination, "storage-node", "identity"))).toEqual(await readFile(f.keystore));
    expect(await readFile(join(destination, "storage-node", "pieces", "piece-1"))).toEqual(Buffer.from("encrypted-piece"));
    const mode = (await import("fs/promises")).stat(join(destination, "storage-node", "identity")).then((s) => s.mode & 0o777);
    await expect(mode).resolves.toBe(0o600);
    await rm(f.root, { recursive: true, force: true });
  });

  it("refuses non-empty restore destinations unless replace is explicit", async () => {
    const f = await fixture();
    const backup = join(f.root, "backup");
    const destination = join(f.root, "restored");
    await createBackup({ destination: backup, sources: { coordinator: { registryPath: f.registry } } });
    await mkdir(destination);
    await writeFile(join(destination, "existing"), "keep");
    await expect(restoreBackup({ backupDir: backup, destination })).rejects.toThrow(/not empty/);
    await restoreBackup({ backupDir: backup, destination, replace: true });
    await expect(readFile(join(destination, "coordinator", "registry"), "utf8")).resolves.toContain("nodes");
    await rm(f.root, { recursive: true, force: true });
  });

  it("preserves opaque encrypted state byte-for-byte", async () => {
    const f = await fixture();
    const backup = join(f.root, "backup");
    await createBackup({ destination: backup, sources: { client: { keystorePath: f.keystore, manifestDir: f.manifests, dekPath: join(f.client, "vault.deks.json") } } });
    await restoreBackup({ backupDir: backup, destination: join(f.root, "restored") });
    expect(await readFile(join(f.root, "restored", "client", "keystore"))).toEqual(await readFile(f.keystore));
    expect(await readFile(join(f.root, "restored", "client", "manifests", "file-1.json"))).toEqual(await readFile(join(f.manifests, "file-1.json")));
    expect((await readFile(join(backup, "data", "client", "keystore"), "utf8")).toString()).not.toContain("encrypted-piece");
    await rm(f.root, { recursive: true, force: true });
  });
});
