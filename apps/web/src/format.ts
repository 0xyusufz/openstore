/**
 * OpenStore Web Frontend — pure formatting helpers (OPENSTORE-023).
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0] as string;
  for (const u of units) {
    unit = u;
    if (value < 1024 || u === "TB") break;
    value /= 1024;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** Deterministic UTC timestamp (`2026-…`), locale-independent. */
export function formatDateTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "—";
  return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ");
}

export type HealthClass = "good" | "warn" | "bad";

export interface HealthGrade {
  label: string;
  class: HealthClass;
}

export function healthGrade(score: number): HealthGrade {
  if (!Number.isFinite(score)) return { label: "Unknown", class: "warn" };
  if (score >= 80) return { label: "Healthy", class: "good" };
  if (score >= 50) return { label: "Fair", class: "warn" };
  return { label: "Poor", class: "bad" };
}

export function truncateId(id: string, keep = 12): string {
  if (typeof id !== "string" || id === "") return "—";
  return id.length <= keep ? id : `${id.slice(0, keep)}…`;
}

export function availabilityLabel(available: boolean): string {
  return available ? "Online" : "Offline";
}

/** Minimal HTML escaping for dynamic content in view templates. */
export function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
