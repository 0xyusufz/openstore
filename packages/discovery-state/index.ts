export type DiscoveryFreshness = "fresh" | "cached" | "stale" | "unavailable" | "reconnecting";
export type DiscoverySource = "coordinator" | "cache" | "manual" | "dht";
export type DiscoveryOperation = "upload" | "download" | "delete" | "repair";

export interface DiscoveryCapabilitySnapshot {
  version: 1;
  freshness: DiscoveryFreshness;
  source: DiscoverySource;
  endpointCount: number;
  observedAt?: number;
  ageMs?: number;
  canReadExisting: boolean;
  canDeleteExisting: boolean;
  canPlaceNew: boolean;
  canRepair: boolean;
  requiresFreshForPlacement: true;
}

export interface DiscoveryObservation {
  source: DiscoverySource;
  endpointCount: number;
  observedAt?: number;
  now?: number;
  reachable?: boolean;
  reconnecting?: boolean;
  usable?: boolean;
}

export interface DiscoveryStateOptions {
  freshMaxAgeMs?: number;
  staleAfterMs?: number;
}

const DEFAULT_FRESH_MAX_AGE_MS = 30_000;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

export class DiscoveryCapabilityModel {
  readonly freshMaxAgeMs: number;
  readonly staleAfterMs: number;

  constructor(options: DiscoveryStateOptions = {}) {
    this.freshMaxAgeMs = positive(options.freshMaxAgeMs ?? DEFAULT_FRESH_MAX_AGE_MS, "freshMaxAgeMs");
    this.staleAfterMs = positive(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS, "staleAfterMs");
    if (this.staleAfterMs < this.freshMaxAgeMs) throw new RangeError("staleAfterMs must be at least freshMaxAgeMs");
  }

  evaluate(observation: DiscoveryObservation): DiscoveryCapabilitySnapshot {
    if (!observation || !Number.isSafeInteger(observation.endpointCount) || observation.endpointCount < 0) {
      throw new TypeError("endpointCount must be a non-negative safe integer");
    }
    const now = observation.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("now must be a non-negative safe integer");
    let freshness: DiscoveryFreshness = "unavailable";
    let ageMs: number | undefined;
    if (observation.usable === false) {
      freshness = "unavailable";
    } else if (observation.reconnecting === true) {
      freshness = "reconnecting";
    } else if (observation.endpointCount > 0 && observation.observedAt !== undefined) {
      if (!Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0 || observation.observedAt > now) {
        throw new TypeError("observedAt must be a valid timestamp");
      }
      ageMs = now - observation.observedAt;
      if (observation.reachable !== false && observation.source === "coordinator" && ageMs <= this.freshMaxAgeMs) freshness = "fresh";
      else if (ageMs <= this.staleAfterMs) freshness = observation.source === "coordinator" && observation.reachable !== false ? "fresh" : "cached";
      else freshness = "stale";
    } else if (observation.endpointCount > 0 && observation.source === "manual") {
      freshness = "cached";
    }
    const usable = observation.endpointCount > 0 && freshness !== "unavailable";
    return Object.freeze({
      version: 1,
      freshness,
      source: observation.source,
      endpointCount: observation.endpointCount,
      ...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
      ...(ageMs === undefined ? {} : { ageMs }),
      canReadExisting: usable,
      canDeleteExisting: usable,
      canPlaceNew: freshness === "fresh",
      canRepair: freshness === "fresh",
      requiresFreshForPlacement: true,
    });
  }

  snapshot(observation: DiscoveryObservation): DiscoveryCapabilitySnapshot {
    return this.evaluate(observation);
  }

  allows(snapshot: DiscoveryCapabilitySnapshot, operation: DiscoveryOperation): boolean {
    if (operation === "upload" || operation === "repair") return snapshot.canPlaceNew && snapshot.canRepair;
    return snapshot.canReadExisting;
  }
}

export const defaultDiscoveryCapabilityModel = new DiscoveryCapabilityModel();
