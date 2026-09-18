/**
 * Shared crash-consistency primitives for storage durability (Milestone 064).
 *
 * Single durability model used by every piece/persistence write path:
 *  - write temp file in the same directory (same filesystem, so rename is atomic)
 *  - fsync file contents before rename
 *  - restrictive 0o600 permissions
 *  - atomic rename onto the final name (readers never observe partial bytes)
 *  - fsync the parent directory so the rename itself is durable
 *  - synchronous temp cleanup on failure
 *
 * Temp files are never valid piece/metadata names, so they can never be
 * mistaken for committed state. Startup recovery removes them
 * deterministically and fsyncs the directory afterwards.
 */

import { randomBytes } from "crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readdir, unlink } from "node:fs/promises";

export type DurabilityCrashStage =
  | "pre-rename"
  | "post-rename"
  | "pre-dir-fsync"
  | "pre-unlink-fsync";

export type DurabilityCrashHook = (stage: DurabilityCrashStage) => void;

/** Temp names always contain a leading dot, so they can never match piece IDs (`[A-Za-z0-9_-]{1,128}`). */
export function isTempFileName(name: string): boolean {
  return (
    name.startsWith(".tmp.") ||
    name.startsWith(".tmp-") ||
    name.includes(".tmp-") ||
    name.endsWith(".tmp")
  );
}

/** Crash-safe file replacement. Throws on failure after best-effort temp cleanup. */
export function durableWriteFileSync(
  finalPath: string,
  bytes: Buffer | string,
  options: { mode?: number; crashHook?: DurabilityCrashHook; tempPrefix?: string } = {},
): void {
  const mode = options.mode ?? 0o600;
  const tempPath = join(
    dirname(finalPath),
    `${options.tempPrefix ?? ".tmp"}.${randomBytes(4).toString("hex")}`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "w", mode);
    if (typeof bytes === "string") writeSync(fd, bytes, null, "utf8");
    else writeSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tempPath, mode);
    options.crashHook?.("pre-rename");
    renameSync(tempPath, finalPath);
    options.crashHook?.("post-rename");
    options.crashHook?.("pre-dir-fsync");
    const dirFd = openSync(dirname(finalPath), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

/**
 * Crash-safe unlink followed by parent-directory fsync so the removal is
 * durable. Unlike `durableWriteFileSync`, a missing file is NOT swallowed:
 * ENOENT propagates so callers can distinguish "deleted" from "not-found"
 * (DELETE → 404 idempotence depends on it).
 */
export function durableUnlinkSync(
  targetPath: string,
  crashHook?: DurabilityCrashHook,
): void {
  unlinkSync(targetPath);
  crashHook?.("pre-unlink-fsync");
  const dirFd = openSync(dirname(targetPath), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Deterministic fail-closed recovery: remove temp artifacts, then fsync the directory. */
export async function recoverDirTempFiles(storageDir: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(storageDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (isTempFileName(entry)) {
      try {
        await unlink(join(storageDir, entry));
        removed.push(entry);
      } catch {}
    }
  }
  try {
    const dirFd = openSync(storageDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {}
  return removed;
}
