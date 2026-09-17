export type EventSeverity = "info" | "warning" | "error";
export type OperationalEventType =
  | "coordinator.started" | "coordinator.closed" | "coordinator.request"
  | "coordinator.discovery.fresh" | "coordinator.discovery.cached" | "coordinator.discovery.stale"
  | "coordinator.discovery.unavailable" | "coordinator.discovery.reconnecting"
  | "node.started" | "node.closed" | "node.draining" | "node.recovery"
  | "node.registration-failed" | "node.heartbeat-failed" | "node.reconnect-failed"
  | "storage.request-rejected" | "storage.request-error"
  | "repair.confirmed-loss" | "repair.attempt" | "repair.completed" | "repair.failed" | "repair.cancelled" | "repair.paused"
  | "orphan.scan-started" | "orphan.scan-completed" | "orphan.scan-failed"
  | "client.upload-failed" | "client.download-failed" | "client.delete-failed";

export type EventDetailValue = string | number | boolean;
export type EventDetails = Readonly<Record<string, EventDetailValue>>;
export interface OperationalEvent {
  version: 1;
  timestamp: number;
  component: "coordinator" | "storage-node" | "client" | "repair" | "orphan-scanner";
  type: OperationalEventType;
  severity: EventSeverity;
  details: EventDetails;
  correlationId?: string;
  operationId?: string;
}

const TYPES = new Set<OperationalEventType>([
  "coordinator.started", "coordinator.closed", "coordinator.request",
  "coordinator.discovery.fresh", "coordinator.discovery.cached", "coordinator.discovery.stale",
  "coordinator.discovery.unavailable", "coordinator.discovery.reconnecting",
  "node.started", "node.closed", "node.draining", "node.recovery",
  "node.registration-failed", "node.heartbeat-failed", "node.reconnect-failed",
  "storage.request-rejected", "storage.request-error",
  "repair.confirmed-loss", "repair.attempt", "repair.completed", "repair.failed", "repair.cancelled", "repair.paused",
  "orphan.scan-started", "orphan.scan-completed", "orphan.scan-failed",
  "client.upload-failed", "client.download-failed", "client.delete-failed",
]);
const COMPONENTS = new Set<OperationalEvent["component"]>(["coordinator", "storage-node", "client", "repair", "orphan-scanner"]);
const DETAIL_KEYS = new Set([
  "operation", "route", "result", "reason", "statusClass", "transport", "state",
  "classification", "attempt", "retryCount", "queueDepth", "activeCount",
  "scanned", "deleted", "retained", "durationMs", "count",
]);
const DETAIL_STRING = /^[a-z][a-z0-9_.-]{0,31}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_DETAIL_BYTES = 2048;

function copyDetails(details: EventDetails): Record<string, EventDetailValue> {
  if (!details || typeof details !== "object" || Array.isArray(details)) throw new TypeError("event details must be an object");
  const output: Record<string, EventDetailValue> = {};
  for (const key of Object.keys(details).sort()) {
    const value = details[key];
    if (!DETAIL_KEYS.has(key) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) {
      throw new TypeError("event details contain an invalid field");
    }
    if (typeof value === "string" && (!DETAIL_STRING.test(value) || /(?:secret|token|password|private|key|seed|dek|filename|plaintext|ciphertext|piece|file|path|url|recovery)/i.test(value))) throw new TypeError("event details contain an invalid value");
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new TypeError("event details contain an invalid number");
    output[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_DETAIL_BYTES) throw new RangeError("event details exceed maximum size");
  return output;
}

export function validateOperationalEvent(input: OperationalEvent): OperationalEvent {
  if (!input || input.version !== 1 || !Number.isFinite(input.timestamp) || input.timestamp < 0 ||
      !COMPONENTS.has(input.component) || !TYPES.has(input.type) ||
      !["info", "warning", "error"].includes(input.severity)) throw new TypeError("invalid operational event");
  for (const id of [input.correlationId, input.operationId]) {
    if (id !== undefined && (!ID.test(id) || /(?:secret|token|password|private|key|seed|dek|file|piece|path|url)/i.test(id))) {
      throw new TypeError("invalid event identifier");
    }
  }
  const details = copyDetails(input.details);
  const event = { ...input, details };
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_DETAIL_BYTES + 1024) throw new RangeError("event exceeds maximum size");
  return event;
}

export class EventStore {
  private readonly events: OperationalEvent[] = [];
  constructor(private readonly maxEvents = 1000) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) throw new TypeError("maxEvents must be a positive safe integer");
  }
  append(input: OperationalEvent): void {
    const event = validateOperationalEvent(input);
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.shift();
  }
  snapshot(limit = this.maxEvents): OperationalEvent[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("limit must be a positive safe integer");
    return this.events.slice(Math.max(0, this.events.length - limit)).map((event) => Object.freeze({
      ...event,
      details: Object.freeze({ ...event.details }),
    }));
  }
  recent(limit = 100): OperationalEvent[] { return this.snapshot(Math.min(limit, this.maxEvents)); }
  clear(): void { this.events.length = 0; }
}

export const defaultEvents = new EventStore();
