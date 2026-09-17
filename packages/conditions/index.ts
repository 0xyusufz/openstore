import type { MetricSnapshot } from "../metrics/index.js";
import type { DiscoveryFreshness } from "../discovery-state/index.js";

export type ConditionSeverity = "info" | "warning" | "critical";
export interface Condition {
  id: string;
  severity: ConditionSeverity;
  active: boolean;
  observed?: number;
  threshold?: number;
  timestamp: number;
  message: string;
}
export interface ConditionInput {
  coordinator?: { persistenceHealthy?: boolean; availableNodes?: number; unavailableNodes?: number; discovery?: { state?: DiscoveryFreshness; ageMs?: number; endpointCount?: number; freshAvailable?: boolean } };
  storage?: { draining?: boolean; usedBytes?: number; allocatedBytes?: number; availableBytes?: number };
  metrics?: MetricSnapshot;
  repair?: { failed?: number; queued?: number; active?: number; capacity?: number };
  orphan?: { failed?: boolean; backlog?: number; batchSize?: number };
  lifecycle?: { reconnecting?: boolean; unavailable?: boolean };
  replica?: { state?: string; persistenceHealthy?: boolean; conflictReason?: string };
  authority?: {
    lifecycle?: "stopped" | "running" | "degraded";
    authoritative?: boolean;
    persistenceHealthy?: boolean;
    persistenceCorrupt?: boolean;
    ownershipConflict?: boolean;
    fenced?: boolean;
    recoveryState?: "unavailable" | "missing-evidence" | "stale" | "conflicted" | "authorization-required" | "authorized" | "recovered" | "rejected";
  };
}
export interface ConditionThresholds {
  capacityWarningRatio: number;
  capacityCriticalRatio: number;
  requestErrorWarning: number;
  repairFailureWarning: number;
  repairQueueWarning: number;
  orphanBacklogWarningRatio: number;
}

export const DEFAULT_CONDITION_THRESHOLDS: Readonly<ConditionThresholds> = Object.freeze({
  capacityWarningRatio: 0.8,
  capacityCriticalRatio: 0.95,
  requestErrorWarning: 5,
  repairFailureWarning: 1,
  repairQueueWarning: 80,
  orphanBacklogWarningRatio: 0.8,
});

const message = (active: boolean, activeMessage: string, clearMessage: string): string => active ? activeMessage : clearMessage;
const n = (value: number | undefined): number | undefined => Number.isFinite(value) && (value as number) >= 0 ? value : undefined;

export class ConditionEvaluator {
  private current: Condition[] = [];
  private readonly thresholds: ConditionThresholds;
  constructor(thresholds: Partial<ConditionThresholds> = {}) {
    this.thresholds = { ...DEFAULT_CONDITION_THRESHOLDS, ...thresholds };
    for (const [key, value] of Object.entries(this.thresholds)) {
      if (!Number.isFinite(value) || value < 0 || (key.endsWith("Ratio") && value > 1)) throw new TypeError(`invalid condition threshold: ${key}`);
    }
  }
  evaluate(input: ConditionInput, timestamp = Date.now()): Condition[] {
    const t = this.thresholds;
    const used = n(input.storage?.usedBytes);
    const allocated = n(input.storage?.allocatedBytes);
    const ratio = used !== undefined && allocated !== undefined && allocated > 0 ? used / allocated : undefined;
    const requestErrors = n(input.metrics?.counters.find((s) => s.name === "storage_request_errors_total")?.value);
    const orphanBacklog = n(input.orphan?.backlog);
    const orphanBatch = n(input.orphan?.batchSize);
    const orphanPressure = orphanBacklog !== undefined && orphanBatch !== undefined && orphanBacklog >= orphanBatch * t.orphanBacklogWarningRatio;
    const discovery = input.coordinator?.discovery;
    const discoveryState = discovery?.state;
    const conditions: Condition[] = [
      { id: "coordinator-discovery-fresh", severity: "info", active: discoveryState === "fresh", timestamp, message: message(discoveryState === "fresh", "Coordinator discovery is fresh.", "Coordinator discovery is not fresh.") },
      { id: "coordinator-discovery-cached", severity: "info", active: discoveryState === "cached", timestamp, message: message(discoveryState === "cached", "Coordinator discovery is cached and suitable only for existing replicas.", "Coordinator discovery is not cached.") },
      { id: "coordinator-discovery-stale", severity: "warning", active: discoveryState === "stale", observed: discovery?.ageMs, timestamp, message: message(discoveryState === "stale", "Coordinator discovery is stale; new placement and repair are blocked.", "Coordinator discovery is not stale.") },
      { id: "coordinator-discovery-unavailable", severity: "critical", active: discoveryState === "unavailable", observed: discovery?.endpointCount, threshold: 1, timestamp, message: message(discoveryState === "unavailable", "Coordinator discovery is unavailable; placement requires recovery.", "Coordinator discovery is available.") },
      { id: "coordinator-discovery-reconnecting", severity: "warning", active: discoveryState === "reconnecting", timestamp, message: message(discoveryState === "reconnecting", "Coordinator discovery is reconnecting; wait for a fresh observation.", "Coordinator discovery is not reconnecting.") },
      { id: "coordinator-persistence-degraded", severity: "critical", active: input.coordinator?.persistenceHealthy === false, timestamp, message: message(input.coordinator?.persistenceHealthy === false, "Coordinator persistence is degraded; inspect registry storage and backups.", "Coordinator persistence is healthy.") },
      { id: "coordinator-no-available-nodes", severity: "critical", active: input.coordinator?.availableNodes === 0, observed: input.coordinator?.availableNodes, threshold: 0, timestamp, message: message(input.coordinator?.availableNodes === 0, "No storage nodes are available for placement.", "At least one storage node is available.") },
      { id: "storage-node-draining", severity: "warning", active: input.storage?.draining === true, timestamp, message: message(input.storage?.draining === true, "Storage node is draining and will reject new placement.", "Storage node is not draining.") },
      { id: "storage-capacity-low", severity: ratio !== undefined && ratio >= t.capacityCriticalRatio ? "critical" : "warning", active: ratio !== undefined && ratio >= t.capacityWarningRatio, observed: ratio, threshold: t.capacityWarningRatio, timestamp, message: message(ratio !== undefined && ratio >= t.capacityWarningRatio, "Storage capacity is low; add capacity or release data safely.", "Storage capacity is below the warning threshold.") },
      { id: "storage-request-errors", severity: "warning", active: requestErrors !== undefined && requestErrors >= t.requestErrorWarning, observed: requestErrors, threshold: t.requestErrorWarning, timestamp, message: message(requestErrors !== undefined && requestErrors >= t.requestErrorWarning, "Storage request errors or rejections are elevated.", "Storage request errors are below the warning threshold.") },
      { id: "repair-failures", severity: "warning", active: (input.repair?.failed ?? 0) >= t.repairFailureWarning, observed: input.repair?.failed, threshold: t.repairFailureWarning, timestamp, message: message((input.repair?.failed ?? 0) >= t.repairFailureWarning, "Repair failures require operator investigation.", "No repair failure condition is active.") },
      { id: "repair-queue-saturation", severity: "warning", active: (input.repair?.queued ?? 0) >= t.repairQueueWarning, observed: input.repair?.queued, threshold: t.repairQueueWarning, timestamp, message: message((input.repair?.queued ?? 0) >= t.repairQueueWarning, "Repair queue pressure is high; inspect node availability and repair capacity.", "Repair queue pressure is below the warning threshold.") },
      { id: "orphan-scanner-failed", severity: "critical", active: input.orphan?.failed === true, timestamp, message: message(input.orphan?.failed === true, "Orphan scanner failed; inspect storage-node logs and cleanup state.", "Orphan scanner is not failed.") },
      { id: "orphan-cleanup-backlog", severity: "warning", active: orphanPressure, observed: orphanBacklog, threshold: orphanBatch === undefined ? undefined : orphanBatch * t.orphanBacklogWarningRatio, timestamp, message: message(orphanPressure, "Orphan cleanup backlog is approaching the bounded scan batch.", "Orphan cleanup backlog is below the warning threshold.") },
      { id: "lifecycle-unavailable", severity: "warning", active: input.lifecycle?.reconnecting === true || input.lifecycle?.unavailable === true, timestamp, message: message(input.lifecycle?.reconnecting === true || input.lifecycle?.unavailable === true, "A service is reconnecting or unavailable; verify coordinator and node connectivity.", "Service lifecycle connectivity is healthy.") },
      ...(input.replica ? [
        { id: "replica-synchronized", severity: "info" as const, active: input.replica.state === "synchronized", timestamp, message: message(input.replica.state === "synchronized", "Coordinator replica synchronization is current.", "Coordinator replica is not synchronized.") },
        { id: "replica-stale", severity: "warning" as const, active: input.replica.state === "stale" || input.replica.state === "retry_wait", timestamp, message: message(input.replica.state === "stale" || input.replica.state === "retry_wait", "Coordinator replica synchronization is stale or retrying.", "Coordinator replica is not stale.") },
        { id: "replica-conflicted", severity: "critical" as const, active: input.replica.state === "conflicted", timestamp, message: message(input.replica.state === "conflicted", "Coordinator replica state is conflicted; operator rebootstrap is required.", "Coordinator replica is not conflicted.") },
        { id: "replica-bootstrap-failed", severity: "critical" as const, active: input.replica.state === "rejected" || input.replica.state === "unavailable", timestamp, message: message(input.replica.state === "rejected" || input.replica.state === "unavailable", "Coordinator replica bootstrap or synchronization failed.", "Coordinator replica bootstrap is not failed.") },
        { id: "replica-persistence-degraded", severity: "critical" as const, active: input.replica.persistenceHealthy === false, timestamp, message: message(input.replica.persistenceHealthy === false, "Coordinator replica persistence is degraded.", "Coordinator replica persistence is healthy.") },
      ] : []),
      ...(input.authority ? [
        { id: "authority_runtime_ready", severity: "info" as const, active: input.authority.lifecycle === "running" && input.authority.authoritative === true, timestamp, message: message(input.authority.lifecycle === "running" && input.authority.authoritative === true, "Authority runtime is ready and authoritative.", "Authority runtime is not authoritative.") },
        { id: "authority_runtime_non_authoritative", severity: "warning" as const, active: input.authority.authoritative === false, timestamp, message: message(input.authority.authoritative === false, "Authority runtime is non-authoritative.", "Authority runtime is authoritative or unavailable.") },
        { id: "authority_persistence_degraded", severity: "critical" as const, active: input.authority.persistenceHealthy === false, timestamp, message: message(input.authority.persistenceHealthy === false, "Authority persistence is degraded.", "Authority persistence is healthy.") },
        { id: "authority_persistence_corrupt", severity: "critical" as const, active: input.authority.persistenceCorrupt === true, timestamp, message: message(input.authority.persistenceCorrupt === true, "Authority persistence is corrupt; runtime remains fail-closed.", "Authority persistence is not corrupt.") },
        { id: "authority_ownership_conflict", severity: "critical" as const, active: input.authority.ownershipConflict === true, timestamp, message: message(input.authority.ownershipConflict === true, "Authority ownership is conflicted.", "Authority ownership is not conflicted.") },
        { id: "authority_fenced", severity: "warning" as const, active: input.authority.fenced === true, timestamp, message: message(input.authority.fenced === true, "Authority owner is fenced.", "Authority owner is not fenced.") },
        { id: "authority_recovery_authorization_required", severity: "warning" as const, active: input.authority.recoveryState === "authorization-required", timestamp, message: message(input.authority.recoveryState === "authorization-required", "Authority recovery requires explicit operator authorization.", "Authority recovery authorization is not required.") },
        { id: "authority_recovery_conflicted", severity: "critical" as const, active: input.authority.recoveryState === "conflicted" || input.authority.recoveryState === "stale", timestamp, message: message(input.authority.recoveryState === "conflicted" || input.authority.recoveryState === "stale", "Authority recovery evidence is stale or conflicted.", "Authority recovery evidence is not stale or conflicted.") },
        { id: "authority_recovery_blocked", severity: "critical" as const, active: input.authority.recoveryState === "rejected" || input.authority.recoveryState === "unavailable", timestamp, message: message(input.authority.recoveryState === "rejected" || input.authority.recoveryState === "unavailable", "Authority recovery is blocked by invalid or unavailable evidence.", "Authority recovery is not blocked.") },
      ] : []),
    ];
    this.current = conditions.map((condition) => Object.freeze({ ...condition }));
    return this.snapshot();
  }
  snapshot(): Condition[] { return this.current.map((condition) => Object.freeze({ ...condition })); }
}
