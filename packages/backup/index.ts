/**
 * OpenStore backup and recovery foundation.
 *
 * Backups are directories containing an inventory.json and a data/ tree.
 * Files are copied as opaque bytes; this module never decrypts or interprets
 * private keys, manifests, pieces, or DEKs.
 */
import { createHash } from "crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { dirname, join, relative, resolve, sep } from "path";

export const BACKUP_FORMAT = "openstore-backup";
export const BACKUP_VERSION = 1;

export type BackupComponent = "client" | "coordinator" | "storage-node";

export interface ClientBackupSource {
  keystorePath: string;
  manifestDir: string;
  operationDir?: string;
  dekPath?: string;
}

export interface CoordinatorBackupSource {
  registryPath: string;
}

export interface StorageNodeBackupSource {
  identityPath: string;
  storageDir: string;
}

export interface BackupSources {
  client?: ClientBackupSource;
  coordinator?: CoordinatorBackupSource;
  storageNode?: StorageNodeBackupSource;
}

export interface BackupEntry {
  component: BackupComponent;
  path: string;
  size: number;
  sha256: string;
  mode: number;
}

export interface BackupInventory {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  openstoreVersion?: string;
  components: BackupComponent[];
  entries: BackupEntry[];
}

export interface BackupOptions {
  destination: string;
  sources: BackupSources;
  openstoreVersion?: string;
  overwrite?: boolean;
}

export interface VerificationReport {
  valid: boolean;
  missing: string[];
  corrupt: string[];
  extra: string[];
  errors: string[];
}

const COMPONENTS: BackupComponent[] = ["client", "coordinator", "storage-node"];
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

function assertComponent(value: string): asserts value is BackupComponent {
  if (!COMPONENTS.includes(value as BackupComponent)) throw new Error(`unsupported backup component: ${value}`);
}

function safeRelative(path: string): void {
  if (!SAFE_RELATIVE.test(path) || path.includes("\\") || path.split("/").some((part) => part === "")) {
    throw new Error(`unsafe backup path: ${path}`);
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

async function digest(path: string): Promise<{ size: number; sha256: string }> {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`backup source is not a regular file: ${path}`);
  const hash = createHash("sha256");
  const bytes = await (await import("fs/promises")).readFile(path);
  hash.update(bytes);
  return { size: bytes.length, sha256: hash.digest("hex") };
}

async function collect(
  source: string,
  component: BackupComponent,
  targetPrefix: string,
  entries: Array<{ component: BackupComponent; source: string; target: string }>,
  excluded: Set<string> = new Set(),
): Promise<void> {
  if (excluded.has(resolve(source))) return;
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`symlink source is not allowed: ${source}`);
  if (info.isFile()) {
    safeRelative(targetPrefix);
    entries.push({ component, source, target: targetPrefix });
    return;
  }
  if (!info.isDirectory()) throw new Error(`unsupported backup source object: ${source}`);
  for (const name of await readdir(source)) {
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error(`unsafe source entry: ${name}`);
    }
    await collect(join(source, name), component, `${targetPrefix}/${name}`, entries, excluded);
  }
}

function addFile(
  entries: Array<{ component: BackupComponent; source: string; target: string }>,
  component: BackupComponent,
  source: string,
  target: string,
): void {
  safeRelative(target);
  entries.push({ component, source: resolve(source), target });
}

async function buildSources(sources: BackupSources): Promise<Array<{ component: BackupComponent; source: string; target: string }>> {
  const entries: Array<{ component: BackupComponent; source: string; target: string }> = [];
  if (sources.client) {
    addFile(entries, "client", sources.client.keystorePath, "client/keystore");
    const excluded = new Set<string>();
    if (sources.client.operationDir && inside(sources.client.manifestDir, sources.client.operationDir)) excluded.add(resolve(sources.client.operationDir));
    if (sources.client.dekPath && inside(sources.client.manifestDir, sources.client.dekPath)) excluded.add(resolve(sources.client.dekPath));
    await collect(resolve(sources.client.manifestDir), "client", "client/manifests", entries, excluded);
    if (sources.client.operationDir) await collect(resolve(sources.client.operationDir), "client", "client/operations", entries);
    if (sources.client.dekPath) addFile(entries, "client", sources.client.dekPath, "client/dek-vault");
  }
  if (sources.coordinator) addFile(entries, "coordinator", sources.coordinator.registryPath, "coordinator/registry");
  if (sources.storageNode) {
    addFile(entries, "storage-node", sources.storageNode.identityPath, "storage-node/identity");
    await collect(resolve(sources.storageNode.storageDir), "storage-node", "storage-node/pieces", entries);
  }
  if (entries.length === 0) throw new Error("at least one backup component is required");
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.target)) throw new Error(`duplicate backup path: ${entry.target}`);
    seen.add(entry.target);
  }
  return entries;
}

export async function createBackup(options: BackupOptions): Promise<BackupInventory> {
  const destination = resolve(options.destination);
  const sourceRoots = [
    ...(options.sources.client ? [options.sources.client.keystorePath, options.sources.client.manifestDir, ...(options.sources.client.operationDir ? [options.sources.client.operationDir] : []), ...(options.sources.client.dekPath ? [options.sources.client.dekPath] : [])] : []),
    ...(options.sources.coordinator ? [options.sources.coordinator.registryPath] : []),
    ...(options.sources.storageNode ? [options.sources.storageNode.identityPath, options.sources.storageNode.storageDir] : []),
  ];
  for (const source of sourceRoots) {
    if (inside(source, destination)) throw new Error("backup destination must not be inside a backup source");
  }
  const entries = await buildSources(options.sources);
  for (const entry of entries) {
    if (inside(entry.source, destination)) throw new Error("backup destination must not be inside a backup source");
  }
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink()) throw new Error("backup destination may not be a symlink");
    if (!options.overwrite) throw new Error("backup destination already exists; choose a new path");
    await rm(destination, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(join(destination, "data"), { recursive: true, mode: 0o700 });
  const inventoryEntries: BackupEntry[] = [];
  try {
    for (const entry of entries) {
      const sourceInfo = await lstat(entry.source);
      if (sourceInfo.isSymbolicLink()) throw new Error(`symlink source is not allowed: ${entry.source}`);
      if (!sourceInfo.isFile()) throw new Error(`backup source changed or is unsafe: ${entry.source}`);
      const target = join(destination, "data", entry.target);
      if (!inside(destination, target)) throw new Error("backup target escapes destination");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(entry.source, target);
      await chmod(target, sourceInfo.mode & 0o777);
      const checksum = await digest(target);
      inventoryEntries.push({ component: entry.component, path: entry.target, ...checksum, mode: sourceInfo.mode & 0o777 });
    }
    const inventory: BackupInventory = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      ...(options.openstoreVersion ? { openstoreVersion: options.openstoreVersion } : {}),
      components: [...new Set(inventoryEntries.map((entry) => entry.component))],
      entries: inventoryEntries.sort((a, b) => a.path.localeCompare(b.path)),
    };
    await writeFile(join(destination, "inventory.json"), JSON.stringify(inventory, null, 2), { mode: 0o600, flag: "wx" });
    return inventory;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function readInventory(backupDir: string): Promise<BackupInventory> {
  const parsed: unknown = JSON.parse(await (await import("fs/promises")).readFile(join(resolve(backupDir), "inventory.json"), "utf8"));
  if (!parsed || typeof parsed !== "object" || (parsed as BackupInventory).format !== BACKUP_FORMAT || (parsed as BackupInventory).version !== BACKUP_VERSION) {
    throw new Error("unsupported or malformed backup inventory");
  }
  const inventory = parsed as BackupInventory;
  if (!Array.isArray(inventory.entries) || !Array.isArray(inventory.components)) throw new Error("malformed backup inventory");
  for (const entry of inventory.entries) {
    if (!entry || typeof entry.path !== "string" || !SAFE_RELATIVE.test(entry.path) || entry.path.includes("\\")) throw new Error("unsafe backup inventory path");
    assertComponent(entry.component);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("malformed backup inventory entry");
  }
  return inventory;
}

export async function verifyBackup(backupDir: string): Promise<VerificationReport> {
  const report: VerificationReport = { valid: false, missing: [], corrupt: [], extra: [], errors: [] };
  try {
    const root = resolve(backupDir);
    const inventory = await readInventory(root);
    const expected = new Set(inventory.entries.map((entry) => entry.path));
    for (const entry of inventory.entries) {
      const path = join(root, "data", entry.path);
      if (!inside(root, path)) { report.errors.push(`unsafe path: ${entry.path}`); continue; }
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) { report.corrupt.push(entry.path); continue; }
        const actual = await digest(path);
        if (actual.size !== entry.size || actual.sha256 !== entry.sha256) report.corrupt.push(entry.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") report.missing.push(entry.path);
        else report.errors.push(`cannot read ${entry.path}`);
      }
    }
    async function scan(dir: string, prefix: string): Promise<void> {
      for (const name of await readdir(dir)) {
        const path = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const info = await lstat(path);
        if (info.isSymbolicLink()) { report.extra.push(rel); continue; }
        if (info.isDirectory()) await scan(path, rel);
        else if (rel !== "inventory.json" && !expected.has(rel.replace(/^data\//, ""))) report.extra.push(rel.replace(/^data\//, ""));
      }
    }
    try { await scan(join(root, "data"), "data"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.errors.push("backup data directory is unreadable"); }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : "invalid backup");
  }
  report.valid = report.missing.length === 0 && report.corrupt.length === 0 && report.extra.length === 0 && report.errors.length === 0;
  return report;
}

export async function restoreBackup(options: { backupDir: string; destination: string; replace?: boolean }): Promise<BackupInventory> {
  const backupDir = resolve(options.backupDir);
  const inventory = await readInventory(backupDir);
  const verification = await verifyBackup(backupDir);
  if (!verification.valid) throw new Error("backup verification failed");
  const destination = resolve(options.destination);
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink()) throw new Error("restore destination may not be a symlink");
    if (!options.replace && (await readdir(destination)).length > 0) throw new Error("restore destination is not empty; use replace to overwrite");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = `${destination}.restore.${Date.now()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const entry of inventory.entries) {
      const source = join(backupDir, "data", entry.path);
      const target = join(staging, entry.path);
      if (!inside(staging, target)) throw new Error("unsafe restore path");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      await chmod(target, entry.mode);
    }
    const targetExists = await stat(destination).then(() => true).catch(() => false);
    if (targetExists && options.replace) {
      const previous = `${destination}.previous.${Date.now()}`;
      await rename(destination, previous);
      try { await rename(staging, destination); } catch (error) { await rename(previous, destination); throw error; }
      await rm(previous, { recursive: true, force: true });
    } else {
      await rename(staging, destination);
    }
    return inventory;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
