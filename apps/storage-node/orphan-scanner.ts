import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { PieceProvenanceStore } from "./provenance-store.js";
import { defaultMetrics, type MetricsRegistry } from "../../packages/metrics/index.js";

export type OrphanScannerState = "stopped" | "running" | "paused" | "cancelling" | "failed";
export interface OrphanScannerEvent {
  type: "scan.started" | "scan.completed" | "scan.cancelled" | "piece.cleanup-eligible" | "piece.cleanup-deleted" | "piece.cleanup-retained" | "piece.cleanup-uncertain" | "piece.cleanup-failed";
  pieceId?: string;
  classification?: string;
  scanned?: number;
  deleted?: number;
  retained?: number;
  timestamp: number;
}
export interface OrphanScanner {
  start(): void;
  stop(): Promise<void>;
  cancel(): void;
  runOnce(): Promise<{ scanned: number; deleted: number; retained: number }>;
  status(): { state: OrphanScannerState; scanned: number; deleted: number; retained: number; lastError?: string };
}

export function createOrphanScanner(options: {
  pieceDir: string;
  provenance: PieceProvenanceStore;
  deletePiece: (pieceId: string) => Promise<"deleted" | "not-found">;
  intervalMs?: number;
  batchSize?: number;
  maxDeletionsPerRun?: number;
  onEvent?: (event: OrphanScannerEvent) => void;
  metrics?: MetricsRegistry;
}): OrphanScanner {
  const intervalMs = options.intervalMs ?? 15 * 60 * 1000;
  const batchSize = options.batchSize ?? 100;
  const maxDeletions = options.maxDeletionsPerRun ?? 10;
  let state: OrphanScannerState = "stopped";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<{ scanned: number; deleted: number; retained: number }> | undefined;
  let cancelled = false;
  let snapshot: { state: OrphanScannerState; scanned: number; deleted: number; retained: number; lastError?: string } = { state, scanned: 0, deleted: 0, retained: 0 };
  const emit = (event: OrphanScannerEvent) => { try { options.onEvent?.(event); } catch {} };
  const metrics = options.metrics ?? defaultMetrics;
  const schedule = () => {
    if (state === "stopped" || state === "cancelling") return;
    timer = setTimeout(() => { void runOnce().finally(schedule); }, intervalMs);
  };
  async function runOnce() {
    if (active) return active;
    cancelled = false;
    state = "running";
    snapshot = { ...snapshot, state };
    const operation = (async () => {
      emit({ type: "scan.started", timestamp: Date.now() });
      metrics.increment("orphan_scan_runs_total", 1, { result: "success" });
      const startedAt = Date.now();
      let scanned = 0, deleted = 0, retained = 0;
      try {
        const entries = (await readdir(options.pieceDir)).slice(0, batchSize);
        for (const entry of entries) {
          if (cancelled) { state = "cancelling"; emit({ type: "scan.cancelled", timestamp: Date.now(), scanned, deleted, retained }); break; }
          const path = join(options.pieceDir, entry);
          let info;
          try { info = await stat(path); } catch { continue; }
          if (!info.isFile() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry)) continue;
          scanned++;
          const inspection = await options.provenance.inspect(entry);
          if (!inspection.eligible || deleted >= maxDeletions) {
            retained++;
            emit({ type: "piece.cleanup-retained", pieceId: entry, classification: inspection.reason, timestamp: Date.now() });
            continue;
          }
          emit({ type: "piece.cleanup-eligible", pieceId: entry, timestamp: Date.now() });
          try {
            const result = await options.provenance.deleteIfUnclaimed(entry, () => options.deletePiece(entry));
            if (result.status === "deleted") { deleted++; emit({ type: "piece.cleanup-deleted", pieceId: entry, timestamp: Date.now() }); }
            else { retained++; emit({ type: "piece.cleanup-retained", pieceId: entry, classification: result.status, timestamp: Date.now() }); }
          } catch (error) {
            retained++;
            emit({ type: "piece.cleanup-uncertain", pieceId: entry, classification: "uncertain", timestamp: Date.now() });
            snapshot = { ...snapshot, lastError: error instanceof Error ? error.message.slice(0, 200) : "cleanup failed" };
          }
        }
        if (state !== "cancelling") state = "paused";
        snapshot = { state, scanned, deleted, retained, lastError: snapshot.lastError };
        metrics.increment("orphan_candidates_total", scanned, { result: "success" });
        metrics.increment("orphan_deleted_total", deleted, { result: "success" });
        metrics.increment("orphan_protected_total", retained, { result: "success" });
        metrics.observe("orphan_scan_duration_ms", Date.now() - startedAt);
        emit({ type: "scan.completed", timestamp: Date.now(), scanned, deleted, retained });
        return { scanned, deleted, retained };
      } catch (error) {
        state = "failed";
        snapshot = { ...snapshot, state, lastError: error instanceof Error ? error.message.slice(0, 200) : "scan failed" };
        emit({ type: "scan.completed", timestamp: Date.now(), scanned, deleted, retained });
        throw error;
      } finally { active = undefined; }
    })();
    active = operation;
    return operation;
  }
  return {
    start() { if (state === "running") return; state = "running"; cancelled = false; snapshot = { ...snapshot, state }; schedule(); },
    async stop() { cancelled = true; if (timer) { clearTimeout(timer); timer = undefined; } if (active) await active; state = "stopped"; snapshot = { ...snapshot, state }; },
    cancel() { cancelled = true; },
    runOnce,
    status: () => ({ ...snapshot }),
  };
}
