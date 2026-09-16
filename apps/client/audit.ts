/**
 * OpenStore Automated Storage Audits (OPENSTORE-018)
 *
 * Periodically verifies that storage nodes still hold expected pieces
 * using metadata-only verification (`verifyPieceOnNode`) — piece
 * contents are never downloaded, and no plaintext, encryption keys,
 * or private keys are ever handled here.
 *
 * Health model:
 * - A verification response with `verified: true` is a healthy event.
 * - A verification response with `verified: false` (missing/corrupted)
 *   is an unhealthy event.
 * - Transport/auth errors produce no verification evidence: they are
 *   reported per piece but excluded from health counters. A node with
 *   no verification responses at all is marked unreachable, and its
 *   reliability is left untouched (availability is already tracked
 *   separately via heartbeat expiry).
 * - Recording is idempotent per `auditId`: the same audit result is
 *   never double-counted.
 */

import { randomBytes } from "crypto";
import type { Registry } from "../../packages/registry/index.js";
import { DEFAULT_TIMEOUT_MS } from "./index.js";
import type { StorageNodeEndpoint } from "./index.js";
import { verifyPieceOnNode } from "./verify.js";

export const AUDIT_VERSION = 1;

/** Default time between scheduled audit runs. */
export const DEFAULT_AUDIT_INTERVAL_MS = 60_000;

/**
 * Options for a single audit run.
 */
export interface AuditOptions {
  /** Max pieces sampled per node (deterministic: sorted IDs, first N). Omit for all. */
  sampleSize?: number;
  timeoutMs?: number;
  /** Ed25519 identity to sign verification requests (private key stays client-side). */
  identity?: { publicKey: Buffer; privateKey: Buffer };
}

/**
 * Per-piece audit detail. Contains metadata only — never piece bytes,
 * plaintext, keys, or private material.
 */
export interface AuditedPiece {
  pieceId: string;
  verified: boolean;
  error?: string;
}

/**
 * Outcome of auditing one node.
 */
export interface NodeAuditOutcome {
  nodeId: string;
  baseUrl: string;
  /** Pieces sampled for this node. */
  checked: number;
  /** Pieces that produced a verification response. */
  responded: number;
  /** Responses with verified: true. */
  healthy: number;
  /** Responses with verified: false (missing/corrupted). */
  unhealthy: number;
  /** Transport/auth errors (excluded from health counters). */
  errored: number;
  /** True when no piece produced a verification response. */
  unreachable: boolean;
  failures: AuditedPiece[];
  error?: string;
}

/**
 * Report for one audit run across nodes.
 */
export interface AuditReport {
  version: number;
  auditId: string;
  auditedAt: number;
  sampleSize?: number;
  results: NodeAuditOutcome[];
}

/**
 * Deterministically sample expected piece IDs: dedupe, sort, take first N.
 * Identical inputs always yield the identical sample.
 */
export function samplePieceIds(pieceIds: string[], sampleSize?: number): string[] {
  if (!Array.isArray(pieceIds)) throw new TypeError("pieceIds must be an array");
  if (sampleSize !== undefined && (!Number.isInteger(sampleSize) || sampleSize <= 0)) {
    throw new RangeError("sampleSize must be a positive integer");
  }
  const unique = Array.from(new Set(pieceIds.filter((id) => typeof id === "string" && id !== ""))).sort();
  return sampleSize === undefined ? unique : unique.slice(0, sampleSize);
}

/**
 * Audit one storage node against its expected piece IDs.
 * Metadata-only verification is used; piece contents are never fetched.
 * Per-piece failures never abort the audit of remaining pieces.
 */
export async function auditNodeEndpoint(
  endpoint: StorageNodeEndpoint,
  expectedPieceIds: string[],
  options: AuditOptions = {},
): Promise<NodeAuditOutcome> {
  if (!endpoint || typeof endpoint.id !== "string" || endpoint.id === "" || typeof endpoint.baseUrl !== "string" || endpoint.baseUrl === "") {
    throw new TypeError("endpoint must be { id, baseUrl } with non-empty strings");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive number");
  }
  const sample = samplePieceIds(expectedPieceIds, options.sampleSize);
  let healthy = 0;
  let unhealthy = 0;
  let errored = 0;
  let responded = 0;
  const failures: AuditedPiece[] = [];
  await Promise.all(
    sample.map(async (pieceId) => {
      try {
        const verification = await verifyPieceOnNode(endpoint, pieceId, {
          timeoutMs,
          identity: options.identity,
        });
        responded += 1;
        if (verification.verified) {
          healthy += 1;
        } else {
          unhealthy += 1;
          failures.push({ pieceId, verified: false, error: verification.error ?? "verification failed" });
        }
      } catch (err) {
        // Transport/auth failure: no verification evidence — exclude from health.
        errored += 1;
        failures.push({ pieceId, verified: false, error: toErrorMessage(err) });
      }
    }),
  );
  const unreachable = sample.length > 0 && responded === 0;
  const outcome: NodeAuditOutcome = {
    nodeId: endpoint.id,
    baseUrl: endpoint.baseUrl,
    checked: sample.length,
    responded,
    healthy,
    unhealthy,
    errored,
    unreachable,
    failures,
  };
  if (unreachable) {
    outcome.error = `node "${endpoint.id}" unreachable: no verification response for ${sample.length} sampled piece(s)`;
  }
  return outcome;
}

/**
 * Audit multiple nodes in one run. One bad node never fails the run.
 *
 * @param endpoints Nodes to audit.
 * @param expectedPieces Either a shared list of piece IDs, or a
 *        per-node map (`nodeId -> piece IDs`), or a resolver function.
 */
export async function auditNodes(
  endpoints: StorageNodeEndpoint[],
  expectedPieces: string[] | Map<string, string[]> | ((endpoint: StorageNodeEndpoint) => string[]),
  options: AuditOptions = {},
): Promise<AuditReport> {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    throw new TypeError("endpoints must be a non-empty array");
  }
  const auditId = randomBytes(16).toString("hex");
  const auditedAt = Date.now();
  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      let ids: string[];
      try {
        if (typeof expectedPieces === "function") {
          ids = expectedPieces(endpoint);
          if (!Array.isArray(ids)) throw new TypeError("resolver must return an array");
        } else if (expectedPieces instanceof Map) {
          ids = expectedPieces.get(endpoint.id) ?? [];
        } else if (Array.isArray(expectedPieces)) {
          ids = expectedPieces;
        } else {
          throw new TypeError("expectedPieces must be an array, Map, or resolver function");
        }
      } catch (err) {
        return {
          nodeId: endpoint.id,
          baseUrl: endpoint.baseUrl,
          checked: 0,
          responded: 0,
          healthy: 0,
          unhealthy: 0,
          errored: 0,
          unreachable: false,
          failures: [],
          error: `failed to resolve expected pieces: ${toErrorMessage(err)}`,
        } satisfies NodeAuditOutcome;
      }
      return auditNodeEndpoint(endpoint, ids, options);
    }),
  );
  return {
    version: AUDIT_VERSION,
    auditId,
    auditedAt,
    ...(options.sampleSize !== undefined ? { sampleSize: options.sampleSize } : {}),
    results,
  };
}

/**
 * Record an audit report into registry storage health.
 * Only outcomes with verification evidence are recorded; unreachable
 * nodes and unknown nodes are skipped. Idempotent per auditId.
 *
 * @returns Node IDs recorded vs skipped.
 */
export function recordAuditReport(
  registry: Registry,
  report: AuditReport,
): { recorded: string[]; skipped: string[] } {
  if (!registry || typeof registry.recordStorageAudit !== "function" || typeof registry.get !== "function") {
    throw new TypeError("registry must expose recordStorageAudit and get");
  }
  if (!report || typeof report !== "object" || typeof report.auditId !== "string" || report.auditId === "" || !Array.isArray(report.results)) {
    throw new TypeError("report must be an AuditReport with auditId and results");
  }
  const recorded: string[] = [];
  const skipped: string[] = [];
  for (const outcome of report.results) {
    if (outcome.unreachable || outcome.responded === 0) {
      skipped.push(outcome.nodeId);
      continue;
    }
    if (!registry.get(outcome.nodeId)) {
      skipped.push(outcome.nodeId);
      continue;
    }
    registry.recordStorageAudit(outcome.nodeId, {
      auditId: report.auditId,
      healthy: outcome.healthy,
      unhealthy: outcome.unhealthy,
    });
    recorded.push(outcome.nodeId);
  }
  return { recorded, skipped };
}

/**
 * Options for the periodic audit scheduler.
 */
export interface AuditSchedulerOptions extends AuditOptions {
  registry: Registry;
  /** Resolve the expected piece IDs for each available endpoint. */
  resolveExpectedPieces: (endpoint: StorageNodeEndpoint) => string[] | Promise<string[]>;
  /** Time between runs. Defaults to {@link DEFAULT_AUDIT_INTERVAL_MS}. */
  intervalMs?: number;
  onReport?: (report: AuditReport) => void;
  onError?: (err: unknown) => void;
}

/**
 * Periodic audit runner. Call `start()` to begin, `stop()` to end.
 */
export interface AuditScheduler {
  readonly running: boolean;
  runOnce(): Promise<AuditReport>;
  start(): void;
  stop(): void;
}

/**
 * Create a configurable periodic storage audit over registry nodes.
 * Failures in one run never crash the scheduler; they go to `onError`.
 */
export function createAuditScheduler(options: AuditSchedulerOptions): AuditScheduler {
  if (!options || typeof options !== "object") throw new TypeError("options must be an object");
  const { registry, resolveExpectedPieces } = options;
  if (!registry || typeof registry.listAvailable !== "function" || typeof registry.recordStorageAudit !== "function") {
    throw new TypeError("options.registry must be a Registry with listAvailable and recordStorageAudit");
  }
  if (typeof resolveExpectedPieces !== "function") throw new TypeError("options.resolveExpectedPieces must be a function");
  const intervalMs = options.intervalMs ?? DEFAULT_AUDIT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive number");
  }
  if (options.sampleSize !== undefined && (!Number.isInteger(options.sampleSize) || options.sampleSize <= 0)) {
    throw new RangeError("sampleSize must be a positive integer");
  }
  const auditOpts: AuditOptions = {
    ...(options.sampleSize !== undefined ? { sampleSize: options.sampleSize } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
  };

  let timer: ReturnType<typeof setInterval> | undefined;

  // The scheduler resolver may be async, so resolution is inlined here
  // (auditNodes itself accepts sync resolvers, Maps, or shared lists).
  async function runOnceImpl(): Promise<AuditReport> {
    const endpoints = registry
      .listAvailable()
      .map((r) => ({
        id: r.nodeId,
        baseUrl: r.baseUrl,
        ...(r.transport === "libp2p" ? {
          multiaddr: r.multiaddr,
          identityBinding: r.identityBinding,
          identity: r.publicKey ? { publicKey: r.publicKey } : undefined,
        } : {}),
      }));
    const auditId = randomBytes(16).toString("hex");
    const auditedAt = Date.now();
    const results = await Promise.all(
      endpoints.map(async (endpoint) => {
        try {
          const ids = await resolveExpectedPieces(endpoint);
          if (!Array.isArray(ids)) throw new TypeError("resolveExpectedPieces must return an array");
          return await auditNodeEndpoint(endpoint, ids, auditOpts);
        } catch (err) {
          return {
            nodeId: endpoint.id,
            baseUrl: endpoint.baseUrl,
            checked: 0,
            responded: 0,
            healthy: 0,
            unhealthy: 0,
            errored: 0,
            unreachable: false,
            failures: [],
            error: `failed to resolve expected pieces: ${toErrorMessage(err)}`,
          } satisfies NodeAuditOutcome;
        }
      }),
    );
    const report: AuditReport = {
      version: AUDIT_VERSION,
      auditId,
      auditedAt,
      ...(auditOpts.sampleSize !== undefined ? { sampleSize: auditOpts.sampleSize } : {}),
      results,
    };
    recordAuditReport(registry, report);
    return report;
  }

  return {
    get running(): boolean {
      return timer !== undefined;
    },
    runOnce: runOnceImpl,
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void runOnceImpl().then(
          (report) => options.onReport?.(report),
          (err) => options.onError?.(err),
        );
      }, intervalMs);
      if (timer && typeof (timer as unknown as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
