/**
 * OpenStore Node Selection (OPENSTORE-013)
 *
 * Intelligent selection of storage nodes based on availability and capacity.
 * Only available nodes with sufficient free space are considered; higher
 * available capacity is preferred. Replication factor is strictly enforced.
 */

import type { NodeRecord, Registry } from "../../packages/registry/index.js";
import { DEFAULT_RELIABILITY_SCORE } from "../../packages/registry/index.js";
import type { StorageNodeEndpoint } from "./index.js";
import { storePieceOnNodes } from "./index.js";
import type { StorePieceOptions, StorePiecesReport } from "./index.js";

export interface SelectionOptions {
  replicationFactor: number;
  pieceSize: number;
}

/**
 * Select storage nodes for a piece based on availability and capacity.
 *
 * @param candidates Node records from registry (e.g. registry.listAvailable()).
 * @param pieceSize Size of the encrypted piece in bytes.
 * @param replicationFactor Number of replicas required.
 * @returns Selected nodes, sorted by most available capacity first.
 * @throws If not enough suitable nodes are available.
 */
export function selectNodes(
  candidates: NodeRecord[],
  pieceSize: number,
  replicationFactor: number,
): NodeRecord[] {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  if (!Number.isInteger(pieceSize) || pieceSize < 0) throw new TypeError("pieceSize must be a non-negative integer");
  if (!Number.isInteger(replicationFactor) || replicationFactor <= 0) throw new RangeError("replicationFactor must be a positive integer");

  const suitable = candidates
    .filter((n) => n.available)
    .filter((n) => n.capacity.availableBytes >= pieceSize)
    .sort((a, b) => {
      const capDiff = b.capacity.availableBytes - a.capacity.availableBytes;
      if (capDiff !== 0) return capDiff;
      // Tie-breaker after capacity: higher reliability first.
      // Missing reliability (legacy records) counts as neutral default.
      const ra = a.reliability?.score ?? DEFAULT_RELIABILITY_SCORE;
      const rb = b.reliability?.score ?? DEFAULT_RELIABILITY_SCORE;
      return rb - ra;
    });

  // Ensure uniqueness (candidates should already be unique, but dedup by nodeId)
  const seen = new Set<string>();
  const unique: NodeRecord[] = [];
  for (const n of suitable) {
    if (!seen.has(n.nodeId)) {
      seen.add(n.nodeId);
      unique.push(n);
    }
  }

  if (unique.length < replicationFactor) {
    throw new Error(
      `insufficient suitable nodes: need ${replicationFactor}, have ${unique.length} (available with enough capacity)`,
    );
  }

  return unique.slice(0, replicationFactor);
}

/**
 * Select endpoints using registry metadata.
 * Converts registry records to StorageNodeEndpoints after selection.
 *
 * @param registry Registry to discover from.
 * @param pieceSize Piece size in bytes.
 * @param replicationFactor Desired replicas.
 * @returns Endpoints for the selected nodes.
 */
export function selectEndpoints(
  registry: Registry,
  pieceSize: number,
  replicationFactor: number,
): StorageNodeEndpoint[] {
  const candidates = registry.listAvailable();
  const selected = selectNodes(candidates, pieceSize, replicationFactor);
  return selected.map((r) => ({ id: r.nodeId, baseUrl: r.baseUrl, reliabilityScore: r.reliability?.score ?? DEFAULT_RELIABILITY_SCORE }));
}

/**
 * Higher-level placement: select nodes intelligently then store.
 * Keeps existing storePieceOnNodes backward compatible (still uses first N when no registry).
 *
 * @param pieceId Piece ID.
 * @param data Piece bytes.
 * @param registry Registry for intelligent selection (or null to use manual endpoints).
 * @param manualEndpoints Fallback manual endpoints (used if registry not provided or for backward compat).
 * @param options Store options plus replicationFactor/pieceSize derived from data.
 * @returns Store report.
 * @throws If selection fails due to insufficient nodes.
 */
export async function storePieceWithSelection(
  pieceId: string,
  data: Buffer,
  registry: Registry | undefined,
  manualEndpoints: StorageNodeEndpoint[],
  options: StorePieceOptions = {},
): Promise<StorePiecesReport> {
  const replicationFactor = options.replicationFactor ?? (registry ? Math.min(3, manualEndpoints.length || 3) : manualEndpoints.length);
  let endpoints: StorageNodeEndpoint[];
  if (registry) {
    const pieceSize = data.length;
    // Use registry selection when available; fall back to manual if registry has no nodes?
    const available = registry.listAvailable();
    if (available.length > 0) {
      try {
        const selected = selectNodes(available, pieceSize, replicationFactor);
        endpoints = selected.map((r) => ({ id: r.nodeId, baseUrl: r.baseUrl, reliabilityScore: r.reliability?.score ?? DEFAULT_RELIABILITY_SCORE }));
      } catch (err) {
        // Fail clearly instead of silently reducing replication
        throw err;
      }
    } else {
      // No registry nodes, use manual
      endpoints = manualEndpoints;
      if (endpoints.length < replicationFactor) {
        throw new Error(`insufficient suitable nodes: need ${replicationFactor}, have ${endpoints.length}`);
      }
      endpoints = endpoints.slice(0, replicationFactor);
    }
  } else {
    endpoints = manualEndpoints;
    // Keep backward compat: storePieceOnNodes handles slicing, but we still enforce unique
    if (endpoints.length < replicationFactor) {
      throw new Error(`insufficient suitable nodes: need ${replicationFactor}, have ${endpoints.length}`);
    }
  }
  return storePieceOnNodes(pieceId, data, endpoints, options);
}
