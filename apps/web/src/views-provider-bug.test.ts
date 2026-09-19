import { describe, expect, it } from "vitest";
import { createInitialState } from "./store.js";
import { renderNodes } from "./views.js";
import type { ProviderStatus } from "../provider.js";

function baseProvider(overrides: Partial<ProviderStatus> & { state: ProviderStatus["state"]; lifecycle: ProviderStatus["lifecycle"] }): ProviderStatus {
  return {
    configured: true,
    storageDir: "/tmp/share",
    port: 4101,
    baseUrl: null,
    nodeId: "test-node",
    draining: false,
    filesystem: { totalBytes: 10_000_000, freeBytes: 5_000_000, usedBytes: 5_000_000 },
    capacity: { allocatedBytes: 4_000_000, usedBytes: 0, availableBytes: 4_000_000, reservedBytes: 0 },
    pieces: { count: 0, bytes: 0, pieceIds: [] },
    reliability: null,
    uptimeMs: 0,
    placementEligible: false,
    placementReason: "offline-not-eligible",
    readiness: "offline",
    conditions: [],
    drainReadiness: { ready: false, reason: "not-draining", remainingPieces: 0, remainingBytes: 0 },
    releaseReadiness: { ready: true, reason: "release-ready", remainingPieces: 0, remainingBytes: 0 },
    ...overrides,
  } as ProviderStatus;
}

describe("provider UX bug 068 — stopped+sharing shows Start Sharing", () => {
  it("stopped + sharing renders Start Sharing wired to provider-start (backend authoritative)", () => {
    const state = { ...createInitialState(), demoMode: false, provider: baseProvider({ state: "stopped", lifecycle: "sharing", readiness: "offline" as const }) };
    const html = renderNodes(state);
    expect(html).toContain('data-action="provider-start"');
    expect(html).toContain("Start Sharing");
    expect(html).not.toContain('data-action="provider-stop"');
    // Must not show draining control in this state
    expect(html).not.toContain("Begin Draining");
  });

  it("sharing + running renders Begin Draining via existing drain transition (provider-stop)", () => {
    const state = { ...createInitialState(), demoMode: false, provider: baseProvider({ state: "running", lifecycle: "sharing", readiness: "ready" as const, draining: false, baseUrl: "http://127.0.0.1:4101", placementEligible: true, placementReason: "eligible", pieces: { count: 3, bytes: 1234, pieceIds: ["a","b","c"] } }) };
    const html = renderNodes(state);
    expect(html).toContain('data-action="provider-stop"');
    expect(html).toContain("Begin Draining");
    expect(html).not.toContain('>Start Sharing<');
    expect(html).not.toContain("Stop Sharing");
  });

  it("draining preserves Resume Sharing, released preserves Resume Sharing", () => {
    const draining = { ...createInitialState(), demoMode: false, provider: baseProvider({ state: "draining", lifecycle: "draining", readiness: "draining" as const, draining: true }) };
    const released = { ...createInitialState(), demoMode: false, provider: baseProvider({ state: "released", lifecycle: "released", readiness: "released" as const }) };
    expect(renderNodes(draining)).toContain('data-action="provider-start"');
    expect(renderNodes(draining)).toContain("Resume Sharing");
    expect(renderNodes(released)).toContain('data-action="provider-start"');
    expect(renderNodes(released)).toContain("Resume Sharing");
    // Draining/released must not show Stop Sharing / Begin Draining
    expect(renderNodes(draining)).not.toContain('data-action="provider-stop"');
    expect(renderNodes(released)).not.toContain('data-action="provider-stop"');
  });

  it("offline + sharing falls through to Start Sharing (authoritative, no new lifecycle invented)", () => {
    const offline = baseProvider({ state: "offline", lifecycle: "sharing", readiness: "offline" as const });
    const html = renderNodes({ ...createInitialState(), demoMode: false, provider: offline });
    expect(html).toContain('data-action="provider-start"');
    expect(html).toContain("Start Sharing");
  });
});
