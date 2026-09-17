import type { DiscoveryFreshness } from "../discovery-state/index.js";

export type AuthorityClassification =
  | "coordinator-authoritative"
  | "dht-discovered"
  | "stale"
  | "invalid"
  | "unavailable";

export interface AuthorityObservation {
  source: "coordinator" | "dht";
  freshness: DiscoveryFreshness | "fresh" | "stale" | "invalid" | "unavailable";
  coordinatorAuthoritative?: boolean;
  endpointCount?: number;
}

export interface AuthorityDecision {
  version: 1;
  classification: AuthorityClassification;
  placementAuthorized: boolean;
  existingReplicaUsable: boolean;
  revocation: "not-established";
}

function count(value: number | undefined): number {
  return value === undefined ? 0 : value;
}

export function classifyAuthority(observation: AuthorityObservation): AuthorityDecision {
  if (!observation || (observation.source !== "coordinator" && observation.source !== "dht")) {
    throw new TypeError("authority observation source is invalid");
  }
  const endpoints = count(observation.endpointCount);
  if (!Number.isSafeInteger(endpoints) || endpoints < 0) throw new TypeError("authority endpoint count is invalid");

  let classification: AuthorityClassification;
  if (observation.freshness === "invalid") classification = "invalid";
  else if (observation.freshness === "unavailable") classification = "unavailable";
  else if (observation.freshness === "stale") classification = "stale";
  else if (observation.source === "coordinator" && observation.freshness === "fresh" && observation.coordinatorAuthoritative === true) {
    classification = "coordinator-authoritative";
  } else {
    classification = "dht-discovered";
  }

  return Object.freeze({
    version: 1,
    classification,
    placementAuthorized: classification === "coordinator-authoritative" && endpoints > 0,
    existingReplicaUsable: endpoints > 0 && classification !== "invalid" && classification !== "unavailable",
    revocation: "not-established",
  });
}

export interface AuthorityReconciliation {
  coordinator: AuthorityDecision;
  dht: AuthorityDecision;
  winner: "coordinator" | "none";
  disagreement: boolean;
  disappearanceImpliesRevocation: false;
}

export function reconcileAuthority(
  coordinator: AuthorityObservation,
  dht: AuthorityObservation,
): AuthorityReconciliation {
  const coordinatorDecision = classifyAuthority({ ...coordinator, source: "coordinator" });
  const dhtDecision = classifyAuthority({ ...dht, source: "dht", coordinatorAuthoritative: false });
  return Object.freeze({
    coordinator: coordinatorDecision,
    dht: dhtDecision,
    winner: coordinatorDecision.placementAuthorized ? "coordinator" : "none",
    disagreement: coordinatorDecision.placementAuthorized !== dhtDecision.existingReplicaUsable,
    disappearanceImpliesRevocation: false,
  });
}
