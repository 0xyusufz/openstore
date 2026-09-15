import { describe, expect, it } from "vitest";
import { availabilityLabel, esc, formatBytes, formatDateTime, healthGrade, truncateId } from "./format.js";

describe("web formatting helpers", () => {
  it("formats byte counts", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12_582_912)).toBe("12.0 MB");
    expect(formatBytes(-1)).toBe("—");
  });

  it("formats timestamps deterministically", () => {
    expect(formatDateTime(1_787_000_000_000)).toBe("2026-08-17 20:53");
    expect(formatDateTime(0)).toBe("—");
    expect(formatDateTime(NaN)).toBe("—");
  });

  it("grades health scores", () => {
    expect(healthGrade(92)).toEqual({ label: "Healthy", class: "good" });
    expect(healthGrade(74)).toEqual({ label: "Fair", class: "warn" });
    expect(healthGrade(41)).toEqual({ label: "Poor", class: "bad" });
    expect(healthGrade(NaN).label).toBe("Unknown");
  });

  it("truncates ids and labels availability", () => {
    expect(truncateId("abcdefghijklmnop", 4)).toBe("abcd…");
    expect(truncateId("short")).toBe("short");
    expect(availabilityLabel(true)).toBe("Online");
    expect(availabilityLabel(false)).toBe("Offline");
  });

  it("escapes HTML", () => {
    expect(esc('<script>alert("x")</script>')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(esc("a&b'c")).toBe("a&amp;b&#39;c");
  });
});
