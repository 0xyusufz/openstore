import type { MetricSnapshot } from "../metrics/index.js";

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
  coordinator?: { persistenceHealthy?: boolean; availableNodes?: number; unavailableNodes?: number };
  storage?: { draining?: boolean; usedBytes?: number; allocatedBytes?: number; availableBytes?: number };
  metrics?: MetricSnapshot;
  repair?: { failed?: number; queued?: number; active?: number; capacity?: number };
  orphan?: { failed?: boolean; backlog?: number; batchSize?: number };
  lifecycle?: { reconnecting?: boolean; unavailable?: boolean };
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
    const conditions: Condition[] = [
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
    ];
    this.current = conditions.map((condition) => Object.freeze({ ...condition }));
    return this.snapshot();
  }
  snapshot(): Condition[] { return this.current.map((condition) => Object.freeze({ ...condition })); }
}
