import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PROVIDER_LIFECYCLE_VERSION = 1;
export type ProviderAllocationLifecycleState = "sharing" | "draining" | "released";

export interface ProviderAllocationLifecycleSnapshot {
  version: 1;
  state: ProviderAllocationLifecycleState;
  updatedAt: number;
}

function persist(path: string, value: ProviderAllocationLifecycleSnapshot): void {
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
    throw new Error(`provider lifecycle persistence failed: ${error instanceof Error ? error.message : "write failed"}`);
  }
}

function load(path: string): ProviderAllocationLifecycleSnapshot {
  if (!existsSync(path)) {
    const initial = { version: 1 as const, state: "sharing" as const, updatedAt: Date.now() };
    persist(path, initial);
    return initial;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch {
    throw new Error("provider lifecycle persistence is corrupt");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("provider lifecycle persistence is malformed");
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || !["sharing", "draining", "released"].includes(String(value.state)) ||
      typeof value.updatedAt !== "number" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) {
    throw new Error("provider lifecycle persistence is invalid");
  }
  return { version: 1, state: value.state as ProviderAllocationLifecycleState, updatedAt: value.updatedAt };
}

export interface ProviderAllocationLifecycle {
  readonly path: string;
  inspect(): ProviderAllocationLifecycleSnapshot;
  startSharing(): ProviderAllocationLifecycleSnapshot;
  stopSharing(): ProviderAllocationLifecycleSnapshot;
  release(usedBytes: number, reservedBytes: number): ProviderAllocationLifecycleSnapshot;
}

export function createProviderAllocationLifecycle(path: string): ProviderAllocationLifecycle {
  if (!path) throw new TypeError("lifecycle path must be non-empty");
  let current = load(path);
  const transition = (state: ProviderAllocationLifecycleState): ProviderAllocationLifecycleSnapshot => {
    if (current.state === "released") throw new Error("released allocation cannot transition");
    if (state === "sharing" && current.state !== "draining") throw new Error("invalid provider lifecycle transition");
    if (state === "draining" && current.state !== "sharing") throw new Error("invalid provider lifecycle transition");
    current = { version: 1, state, updatedAt: Date.now() };
    persist(path, current);
    return { ...current };
  };
  return {
    path,
    inspect: () => ({ ...current }),
    startSharing: () => transition("sharing"),
    stopSharing: () => transition("draining"),
    release(usedBytes, reservedBytes) {
      if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 || !Number.isSafeInteger(reservedBytes) || reservedBytes < 0) {
        throw new TypeError("usage values must be non-negative safe integers");
      }
      if (current.state !== "draining") throw new Error("allocation must be draining before release");
      if (usedBytes !== 0 || reservedBytes !== 0) throw new Error("allocation cannot be released while pieces or reservations remain");
      current = { version: 1, state: "released", updatedAt: Date.now() };
      persist(path, current);
      return { ...current };
    },
  };
}
