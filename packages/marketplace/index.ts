/**
 * OpenStore Marketplace (069)
 *
 * Backend-authoritative provider listing derived from the coordinator/registry.
 * Reuses lifecycle/capacity/selection foundations; never invents placements
 * from stale data and never exposes secrets.
 *
 * - Listing is authoritative only when derived from a live registry snapshot.
 * - Draining/released/ineligible providers are never purchasable.
 * - Presentation is capacity/operational only; no economics/credits/payment.
 */

import type { NodeRecord, Registry } from "../registry/index.js";
import { DEFAULT_RELIABILITY_SCORE } from "../registry/index.js";
import { isPlacementEligible } from "../placement/index.js";

export const MARKETPLACE_VERSION = 1;

/** Sanitized provider entry shown in the marketplace. */
export interface MarketplaceProvider {
  /** Public node identifier (base64 public key). Safe to expose. */
  id: string;
  baseUrl: string;
  /** Always "sharing" for eligible listings; draining/released are excluded. */
  lifecycle: "sharing";
  allocatedBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** Heartbeat reliability 0-100. */
  score: number;
  /** Storage-audit health 0-100. */
  storageScore: number;
  lastSeen: number;
  /** Transport hint when known. */
  transport?: "http" | "libp2p";
  /** Whether registry reports available (always true for listings). */
  available: true;
}

/** Filter for marketplace discovery (future marketplace will need these). */
export interface MarketplaceFilter {
  /** Minimum purchasable bytes. */
  minAvailableBytes?: number;
  /** Minimum heartbeat reliability score 0-100. */
  minScore?: number;
  /** Minimum storage health 0-100. */
  minStorageScore?: number;
  /** Transport constraint. */
  transport?: "http" | "libp2p";
  /** Maximum providers to return (1..100, default 50). */
  limit?: number;
  /** Offset for pagination (default 0). */
  offset?: number;
}

/** Aggregated snapshot — safe to serve as marketplace source of truth. */
export interface MarketplaceSnapshot {
  version: number;
  generatedAt: number;
  source: "live" | "demo";
  providers: MarketplaceProvider[];
  totalAvailableBytes: number;
  totalAllocatedBytes: number;
  totalUsedBytes: number;
  providerCount: number;
}

/** Validate filter without leaking internals. */
export function validateMarketplaceFilter(filter: unknown): MarketplaceFilter {
  if (filter == null || filter === undefined) return {};
  if (typeof filter !== "object" || Array.isArray(filter)) throw new TypeError("filter must be an object");
  const f = filter as Record<string, unknown>;
  const out: MarketplaceFilter = {};
  if (f["minAvailableBytes"] !== undefined) {
    const v = f["minAvailableBytes"];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new TypeError("minAvailableBytes must be a non-negative safe integer");
    out.minAvailableBytes = v;
  }
  if (f["minScore"] !== undefined) {
    const v = f["minScore"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) throw new TypeError("minScore must be 0-100");
    out.minScore = v;
  }
  if (f["minStorageScore"] !== undefined) {
    const v = f["minStorageScore"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) throw new TypeError("minStorageScore must be 0-100");
    out.minStorageScore = v;
  }
  if (f["transport"] !== undefined) {
    const v = f["transport"];
    if (v !== "http" && v !== "libp2p") throw new TypeError("transport must be http or libp2p");
    out.transport = v;
  }
  if (f["limit"] !== undefined) {
    const v = f["limit"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 100) throw new TypeError("limit must be 1-100");
    out.limit = v;
  }
  if (f["offset"] !== undefined) {
    const v = f["offset"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new TypeError("offset must be a non-negative integer");
    out.offset = v;
  }
  return out;
}

/** Whether a registry record is eligible for marketplace purchase (reuses 058-068 eligibility). */
export function isMarketplaceEligible(record: NodeRecord): boolean {
  if (!record || typeof record !== "object") return false;
  if (record.available !== true) return false;
  // Reuse authoritative placement eligibility (selection.ts) — draining/released/stale/unavailable/capacity-invalid all ineligible.
  // HTTP lifecycle gap: Registry NodeRecord.lifecycle for HTTP nodes is fundamentally unavailable.
  // HTTP storage nodes (apps/storage-node/index.ts: registerSigned/heartbeatSigned) only propagate
  // capacity (allocated/used/available), not lifecycle. Unlike libp2p where descriptor.capabilities.lifecycle
  // is persisted as NodeRecord.lifecycle, HTTP nodes always have lifecycle === undefined in registry.
  // Treating undefined as "sharing" would incorrectly list draining HTTP providers as allocatable.
  // Safest fail-closed marketplace behavior: require explicit lifecycle === "sharing".
  // Eligible HTTP providers must be registered with explicit lifecycle "sharing" (future HTTP fix);
  // until then, HTTP nodes with undefined lifecycle are not marketplace-eligible.
  if (record.lifecycle !== "sharing") return false;
  // Reuse existing authoritative capacity/endpoint helper for remaining checks.
  // Use minimal pieceSize (1) to ensure any purchasable capacity must have at least 1 byte available
  // and that endpoint passes the shared placement eligibility validation.
  const endpoint = {
    id: record.nodeId,
    baseUrl: record.baseUrl,
    lifecycle: record.lifecycle,
    capacity: record.capacity,
    capabilities: record.capabilities,
  } as unknown as Parameters<typeof isPlacementEligible>[0];
  if (!isPlacementEligible(endpoint, 1)) return false;
  return true;
}

/** Project a NodeRecord onto its sanitized marketplace form (no secrets). */
export function toMarketplaceProvider(record: NodeRecord): MarketplaceProvider {
  if (!isMarketplaceEligible(record)) throw new Error("record is not marketplace eligible");
  const allocated = record.capacity.allocatedBytes ?? (record.capacity as unknown as { totalBytes: number }).totalBytes as number;
  return {
    id: record.nodeId,
    baseUrl: record.baseUrl,
    lifecycle: "sharing",
    allocatedBytes: allocated,
    usedBytes: record.capacity.usedBytes,
    availableBytes: record.capacity.availableBytes,
    score: record.reliability?.score ?? DEFAULT_RELIABILITY_SCORE,
    storageScore: record.reliability?.storageScore ?? DEFAULT_RELIABILITY_SCORE,
    lastSeen: record.lastSeen,
    ...(record.transport ? { transport: record.transport } : {}),
    available: true,
  };
}

/** List eligible providers from a registry snapshot, applying optional filters. */
export function listMarketplaceProviders(registry: Registry, filter: MarketplaceFilter = {}): MarketplaceProvider[] {
  if (!registry || typeof registry.list !== "function") throw new TypeError("registry is required");
  const f = validateMarketplaceFilter(filter);
  let providers = registry.list().filter(isMarketplaceEligible).map(toMarketplaceProvider);
  // Additional marketplace filtering (future storage needs)
  if (f.minAvailableBytes !== undefined) {
    providers = providers.filter((p) => p.availableBytes >= (f.minAvailableBytes as number));
  }
  if (f.minScore !== undefined) {
    providers = providers.filter((p) => p.score >= (f.minScore as number));
  }
  if (f.minStorageScore !== undefined) {
    providers = providers.filter((p) => p.storageScore >= (f.minStorageScore as number));
  }
  if (f.transport !== undefined) {
    providers = providers.filter((p) => (p.transport ?? "http") === f.transport);
  }
  // Deterministic marketplace ordering: most available first, then highest reliability, then id for stability.
  providers.sort((a, b) => {
    const cap = b.availableBytes - a.availableBytes;
    if (cap !== 0) return cap;
    const score = b.score - a.score;
    if (score !== 0) return score;
    return a.id.localeCompare(b.id);
  });
  const offset = f.offset ?? 0;
  const limit = f.limit ?? 50;
  return providers.slice(offset, offset + limit);
}

/** Aggregated snapshot with totals — fail-closed if registry is not authoritative. */
export function getMarketplaceSnapshot(registry: Registry | null | undefined, filter: MarketplaceFilter = {}, source: "live" | "demo" = "live"): MarketplaceSnapshot {
  const f = validateMarketplaceFilter(filter);
  if (!registry) {
    // Fail closed: without an authoritative registry there is no purchasable capacity.
    // Caller should surface "marketplace unavailable" rather than inventing listings.
    throw new Error("marketplace unavailable: coordinator not configured");
  }
  const providers = listMarketplaceProviders(registry, f);
  const totalAvailableBytes = providers.reduce((s, p) => s + p.availableBytes, 0);
  const totalAllocatedBytes = providers.reduce((s, p) => s + p.allocatedBytes, 0);
  const totalUsedBytes = providers.reduce((s, p) => s + p.usedBytes, 0);
  return {
    version: MARKETPLACE_VERSION,
    generatedAt: Date.now(),
    source,
    providers,
    totalAvailableBytes,
    totalAllocatedBytes,
    totalUsedBytes,
    providerCount: providers.length,
  };
}

/** Factory for backend-authoritative marketplace (reuses registry). */
export function createMarketplace(registry: Registry) {
  if (!registry) throw new TypeError("registry is required");
  return {
    version: MARKETPLACE_VERSION,
    list(filter?: MarketplaceFilter): MarketplaceProvider[] {
      return listMarketplaceProviders(registry, filter ?? {});
    },
    snapshot(filter?: MarketplaceFilter): MarketplaceSnapshot {
      return getMarketplaceSnapshot(registry, filter ?? {}, "live");
    },
    isEligible(record: NodeRecord): boolean {
      return isMarketplaceEligible(record);
    },
  };
}
