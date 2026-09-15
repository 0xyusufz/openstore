/**
 * OpenStore Web Frontend — view models (OPENSTORE-023).
 *
 * Thin presentation types built on existing library types. Only safe,
 * already-public metadata is modeled here — never keys, phrases,
 * passwords, plaintext, or piece bytes.
 */

import type { CatalogEntry } from "../../client/catalog.js";
import type { NodeRecord } from "../../../packages/registry/index.js";

/** Files shown in the UI are catalog entries (safe metadata only). */
export type WebFile = CatalogEntry;

/**
 * Node summary shown in the UI: identity + capacity + health.
 * Derived from {@link NodeRecord}; signatures and nonces never surface.
 */
export interface WebNode {
  id: string;
  baseUrl: string;
  available: boolean;
  allocatedBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** Heartbeat reliability score 0–100. */
  score: number;
  /** Storage-audit health score 0–100. */
  storageScore: number;
  lastSeen: number;
}

/** Local identity status shown in Settings (presence only, no secrets). */
export interface WebIdentityStatus {
  configured: boolean;
  /** True after a successful keystore unlock (server-side session flag). */
  unlocked: boolean;
  /** Human label such as a truncated public key or "(demo)". */
  label: string;
  /** Base64 public key when a keystore is linked. Safe to display. */
  publicKey?: string;
}

/** Aggregates for the dashboard, computed from files + nodes. */
export interface DashboardStats {
  fileCount: number;
  totalChunks: number;
  bytesUsed: number;
  bytesAllocated: number;
  bytesAvailable: number;
  nodeCount: number;
  nodesOnline: number;
  avgScore: number;
}

/**
 * Project a registry record onto its UI-safe subset.
 */
export function toWebNode(record: NodeRecord): WebNode {
  const allocated = record.capacity.allocatedBytes ?? record.capacity.totalBytes ?? 0;
  return {
    id: record.nodeId,
    baseUrl: record.baseUrl,
    available: record.available,
    allocatedBytes: allocated,
    usedBytes: record.capacity.usedBytes,
    availableBytes: record.capacity.availableBytes,
    score: record.reliability.score,
    storageScore: record.reliability.storageScore,
    lastSeen: record.lastSeen,
  };
}
