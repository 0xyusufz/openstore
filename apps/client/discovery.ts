/**
 * OpenStore Client Discovery (OPENSTORE-011)
 *
 * Helpers to discover available storage nodes from the authenticated registry
 * while keeping manually configured endpoints fully supported.
 */

import type { Registry } from "../../packages/registry/index.js";
import type { StorageNodeEndpoint } from "./index.js";

export {
  createCoordinatorAdapter,
  coordinatorNodesToEndpoints,
  resolveEndpoints,
} from "./coordinator.js";
export type {
  CoordinatorAdapter,
  CoordinatorAdapterOptions,
} from "./coordinator.js";

/**
 * Discover available endpoints from the registry.
 * Returns only currently available/valid nodes (heartbeat not expired).
 *
 * @param registry In-memory registry instance.
 * @returns Available endpoints (may be empty).
 */
export function discoverAvailableEndpoints(registry: Registry): StorageNodeEndpoint[] {
  return registry.getAvailableEndpoints();
}

/**
 * Merge manual endpoints with discovered ones, deduplicating by id and baseUrl.
 *
 * @param manual Manually configured endpoints (kept as-is).
 * @param discovered Endpoints from registry discovery.
 * @returns Combined list with manual first, then discovered not already present.
 */
export function mergeEndpoints(
  manual: StorageNodeEndpoint[],
  discovered: StorageNodeEndpoint[],
): StorageNodeEndpoint[] {
  const seen = new Set<string>();
  const result: StorageNodeEndpoint[] = [];
  for (const ep of manual) {
    const key = `${ep.id}|${ep.baseUrl}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(ep);
    }
  }
  for (const ep of discovered) {
    const key = `${ep.id}|${ep.baseUrl}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(ep);
    }
  }
  return result;
}

/**
 * Discover and merge — convenience for clients that use both sources.
 *
 * @param registry Registry to discover from.
 * @param manual Optional manual endpoints.
 * @returns All available endpoints (manual + discovered).
 */
export function discoverEndpoints(
  registry: Registry,
  manual: StorageNodeEndpoint[] = [],
): StorageNodeEndpoint[] {
  const discovered = discoverAvailableEndpoints(registry);
  return mergeEndpoints(manual, discovered);
}
