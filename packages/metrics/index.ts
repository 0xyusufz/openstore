export type MetricLabels = Record<string, string>;
export interface MetricSample { name: string; labels: MetricLabels; value: number; }
export interface MetricSnapshot { counters: MetricSample[]; gauges: MetricSample[]; histograms: MetricSample[]; }

const NAME = /^[a-z][a-z0-9_]{0,127}$/;
const VALUE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const ALLOWED_KEYS = new Set(["operation", "route", "result", "status_class", "transport", "reason"]);
const ALLOWED_VALUES: Record<string, Set<string>> = {
  operation: new Set(["request", "register", "heartbeat", "unregister", "store", "get", "head", "delete", "verify", "upload", "download", "repair"]),
  route: new Set(["request", "health", "status", "nodes", "register", "heartbeat", "unregister", "ready", "metrics", "pieces"]),
  result: new Set(["success", "error", "rejected", "absent"]),
  status_class: new Set(["2xx", "4xx", "5xx"]),
  transport: new Set(["http", "libp2p"]),
  reason: new Set(["capacity", "draining", "integrity", "transient", "permanent", "expired"]),
};

function validateName(name: string): void {
  if (!NAME.test(name)) throw new TypeError(`invalid metric name: ${name}`);
}
function normalizeLabels(labels: MetricLabels = {}): string {
  const keys = Object.keys(labels).sort();
  if (keys.length > 4 || keys.some((key) => !ALLOWED_KEYS.has(key) || !VALUE.test(key) || !VALUE.test(labels[key] ?? "") || !ALLOWED_VALUES[key]?.has(labels[key]!))) {
    throw new TypeError("invalid metric labels");
  }
  return keys.map((key) => `${key}=${labels[key]}`).join(",");
}
export class MetricsRegistry {
  private readonly counters = new Map<string, MetricSample>();
  private readonly gauges = new Map<string, MetricSample>();
  private readonly histograms = new Map<string, { labels: MetricLabels; count: number; sum: number; max: number }>();
  constructor(private readonly maxSeries = 512) {
    if (!Number.isSafeInteger(maxSeries) || maxSeries <= 0) throw new TypeError("maxSeries must be positive");
  }
  private key(name: string, labels: MetricLabels): string { validateName(name); return `${name}|${normalizeLabels(labels)}`; }
  private ensure(map: Map<string, unknown>, key: string): void {
    if (!map.has(key) && this.counters.size + this.gauges.size + this.histograms.size >= this.maxSeries) {
      throw new RangeError("metric series limit exceeded");
    }
  }
  increment(name: string, value = 1, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) throw new TypeError("counter value must be finite and non-negative");
    const key = this.key(name, labels); this.ensure(this.counters, key);
    const current = this.counters.get(key); this.counters.set(key, { name, labels: current?.labels ?? { ...labels }, value: (current?.value ?? 0) + value });
  }
  set(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value)) throw new TypeError("gauge value must be finite");
    const key = this.key(name, labels); this.ensure(this.gauges, key);
    this.gauges.set(key, { name, labels: { ...labels }, value });
  }
  observe(name: string, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) throw new TypeError("histogram value must be finite and non-negative");
    const key = this.key(name, labels); this.ensure(this.histograms, key);
    const current = this.histograms.get(key);
    this.histograms.set(key, { labels: current?.labels ?? { ...labels }, count: (current?.count ?? 0) + 1, sum: (current?.sum ?? 0) + value, max: Math.max(current?.max ?? 0, value) });
  }
  snapshot(): MetricSnapshot {
    return {
      counters: [...this.counters.values()].sort((a, b) => a.name.localeCompare(b.name) || JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels))),
      gauges: [...this.gauges.values()].sort((a, b) => a.name.localeCompare(b.name)),
      histograms: [...this.histograms.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ name: key.split("|")[0]!, labels: { ...value.labels }, value: value.count ? value.sum / value.count : 0 })),
    };
  }
  reset(): void { this.counters.clear(); this.gauges.clear(); this.histograms.clear(); }
}

export const defaultMetrics = new MetricsRegistry();
