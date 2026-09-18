import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CAPACITY_ALLOCATION_VERSION = 1;
export const DEFAULT_ALLOCATION_BYTES = 1 * 1024 * 1024 * 1024;

export interface FilesystemCapacity {
  physicalBytes: number;
  usableBytes: number;
}

export interface CapacityAllocationState {
  version: 1;
  allocationBytes: number;
  usedBytes: number;
  reservedBytes: number;
  physicalBytes: number;
  usableBytes: number;
  availableBytes: number;
}

export interface CapacityAllocation {
  readonly path: string;
  readonly filesystem: FilesystemCapacity;
  state(): CapacityAllocationState;
  setAllocation(allocationBytes: number, usedBytes?: number): CapacityAllocationState;
  updateUsed(usedBytes: number): CapacityAllocationState;
}

function validBytes(value: unknown, name: string, allowZero = true): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
}

export function filesystemCapacity(storageDir: string): FilesystemCapacity {
  if (typeof storageDir !== "string" || storageDir.length === 0) throw new TypeError("storageDir must be a non-empty string");
  let stats;
  try { stats = statfsSync(storageDir); } catch (error) {
    throw new Error(`filesystem capacity unavailable: ${error instanceof Error ? error.message : "stat failed"}`);
  }
  const blockSize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const availableBlocks = Number(stats.bavail);
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0 || !Number.isSafeInteger(blocks) || blocks < 0 || !Number.isSafeInteger(availableBlocks) || availableBlocks < 0) {
    throw new Error("filesystem capacity is invalid");
  }
  const physicalBytes = blocks * blockSize;
  const usableBytes = availableBlocks * blockSize;
  if (!Number.isSafeInteger(physicalBytes) || !Number.isSafeInteger(usableBytes) || usableBytes > physicalBytes) {
    throw new Error("filesystem capacity exceeds safe integer bounds");
  }
  return { physicalBytes, usableBytes };
}

function persist(path: string, value: CapacityAllocationState): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  try {
    fd = openSync(temp, "w", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    const dirFd = openSync(dirname(path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch {}
    throw new Error(`capacity allocation persistence failed: ${error instanceof Error ? error.message : "write failed"}`);
  }
}

function read(path: string, fs: FilesystemCapacity): CapacityAllocationState | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error("capacity allocation persistence is corrupt");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("capacity allocation persistence is malformed");
  const value = parsed as Record<string, unknown>;
  if (value.version !== CAPACITY_ALLOCATION_VERSION) throw new Error("capacity allocation persistence version is unsupported");
  const allocationBytes = value.allocationBytes;
  const usedBytes = value.usedBytes;
  const reservedBytes = value.reservedBytes;
  const physicalBytes = value.physicalBytes;
  const usableBytes = value.usableBytes;
  validBytes(allocationBytes, "allocationBytes", false);
  validBytes(usedBytes, "usedBytes");
  validBytes(reservedBytes, "reservedBytes");
  validBytes(physicalBytes, "physicalBytes");
  validBytes(usableBytes, "usableBytes");
  if (physicalBytes < usableBytes || allocationBytes > usableBytes || allocationBytes > fs.usableBytes || usedBytes > allocationBytes || reservedBytes > allocationBytes - usedBytes) {
    throw new Error("capacity allocation persistence is impossible");
  }
  return { version: 1, allocationBytes, usedBytes, reservedBytes, physicalBytes: fs.physicalBytes, usableBytes: fs.usableBytes, availableBytes: allocationBytes - usedBytes - reservedBytes };
}

export function createCapacityAllocation(storageDir: string, configuredAllocationBytes?: number, allocationPath = join(storageDir, ".capacity-allocation.json")): CapacityAllocation {
  const filesystem = filesystemCapacity(storageDir);
  const persisted = read(allocationPath, filesystem);
  if (persisted && configuredAllocationBytes !== undefined && configuredAllocationBytes !== persisted.allocationBytes) {
    throw new Error("configured allocation does not match persisted allocation");
  }
  const initial = persisted ?? (() => {
    if (configuredAllocationBytes === undefined) throw new Error("allocation must be explicitly configured when persisted state is absent");
    const allocationBytes = configuredAllocationBytes;
    validBytes(allocationBytes, "allocationBytes", false);
    if (allocationBytes > filesystem.usableBytes) throw new RangeError("allocation exceeds usable filesystem capacity");
    const state: CapacityAllocationState = { version: 1, allocationBytes, usedBytes: 0, reservedBytes: 0, availableBytes: allocationBytes, ...filesystem };
    persist(allocationPath, state);
    return state;
  })();
  let current = initial;
  return {
    path: allocationPath,
    filesystem,
    state: () => ({ ...current }),
    setAllocation(next, used = current.usedBytes) {
      validBytes(next, "allocationBytes", false);
      validBytes(used, "usedBytes");
      const refreshedFilesystem = filesystemCapacity(storageDir);
      if (next > refreshedFilesystem.usableBytes) throw new RangeError("allocation exceeds usable filesystem capacity");
      if (used > next || current.reservedBytes > next - used) throw new RangeError("allocation decrease would exceed current usage or reservations");
      current = { ...current, allocationBytes: next, usedBytes: used, availableBytes: next - used - current.reservedBytes, physicalBytes: refreshedFilesystem.physicalBytes, usableBytes: refreshedFilesystem.usableBytes };
      persist(allocationPath, current);
      return { ...current };
    },
    updateUsed(used) {
      validBytes(used, "usedBytes");
      if (used > current.allocationBytes) throw new RangeError("used bytes exceed allocation");
      current = { ...current, usedBytes: used, availableBytes: current.allocationBytes - used - current.reservedBytes };
      persist(allocationPath, current);
      return { ...current };
    },
  };
}
