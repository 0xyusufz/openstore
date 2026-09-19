import { describe, expect, it } from "vitest";
import { createInitialState } from "./src/store.js";
import { renderApp, renderDashboard, renderSettings, renderLogin } from "./src/views.js";
import { dashboardStats } from "./src/store.js";
import type { ProviderStatus } from "./provider.js";

function provider(overrides: Partial<ProviderStatus>): ProviderStatus {
  return {
    configured: true,
    state: "running",
    lifecycle: "sharing",
    storageDir: "/tmp/share",
    port: 4101,
    baseUrl: "http://127.0.0.1:4101",
    nodeId: "test-node",
    draining: false,
    filesystem: { totalBytes: 10_000_000, freeBytes: 5_000_000, usedBytes: 5_000_000 },
    capacity: { allocatedBytes: 4_000_000, usedBytes: 1000, availableBytes: 3999000, reservedBytes: 0 },
    pieces: { count: 1, bytes: 1000, pieceIds: ["a"] },
    reliability: { score: 80, storageScore: 70, successfulHeartbeats: 1, missedHeartbeats: 0 },
    uptimeMs: 1000,
    placementEligible: true,
    placementReason: "eligible",
    readiness: "ready",
    conditions: [],
    drainReadiness: { ready: true, reason: "drain-ready", remainingPieces: 0, remainingBytes: 0 },
    releaseReadiness: { ready: false, reason: "pieces-remain", remainingPieces: 1, remainingBytes: 1000 },
    ...overrides,
  } as unknown as ProviderStatus;
}

function dashboardState(overrides: Record<string, unknown> = {}) {
  return { ...createInitialState(), view: "dashboard" as const, ...overrides };
}

describe("account UX cleanup + provider visibility", () => {
  it("top-right shows Log Out when unlocked, Log In when locked", () => {
    const unlocked = dashboardState({ identity: { configured: true, unlocked: true, label: "local keystore", publicKey: "abc" }, provider: provider({}), demoMode: false });
    const htmlUnlocked = renderApp(unlocked, dashboardStats(unlocked));
    expect(htmlUnlocked).toContain("Log Out");
    expect(htmlUnlocked).toContain('data-action="identity-logout"');
    expect(htmlUnlocked).not.toContain("Log In</a>");

    const locked = dashboardState({ identity: { configured: true, unlocked: false, label: "local keystore", publicKey: "abc" }, provider: provider({}), demoMode: false });
    const htmlLocked = renderApp(locked, dashboardStats(locked));
    expect(htmlLocked).toContain("Log In");
    expect(htmlLocked).not.toContain('>Log Out<');
  });

  it("does not call Delete Account and logout does not delete data", () => {
    const state = dashboardState({ identity: { configured: true, unlocked: true, label: "local keystore", publicKey: "abc" }, provider: provider({}), demoMode: false });
    const html = renderApp(state, dashboardStats(state));
    expect(html).not.toContain("Delete Account");
    expect(html).toContain("Log Out");
  });

  it("Settings shows Account info, Change Password, Switch Account link, Log Out when unlocked", () => {
    const state = dashboardState({ identity: { configured: true, unlocked: true, label: "local keystore", publicKey: "abc" }, provider: provider({}), demoMode: false });
    const html = renderSettings(state);
    expect(html).toContain("Account");
    expect(html).toContain("<summary>Change Password</summary>");
    expect(html).toContain('data-action="identity-logout"');
    expect(html).toContain("Switch Account");
    expect(html).toContain('href="#/login"');
    expect(html).toContain("Log Out");
  });

  it("Settings shows link to login when not unlocked", () => {
    const state = dashboardState({ identity: { configured: true, unlocked: false, label: "local keystore", publicKey: "abc" }, provider: provider({}), demoMode: false });
    const html = renderSettings(state);
    expect(html).toContain('href="#/login"');
    expect(html).toContain("Go to Login");
    expect(html).not.toContain("Lock Account");
  });

  it("password semantics preserved in Settings", () => {
    const unlocked = dashboardState({ identity: { configured: true, unlocked: true, label: "local keystore", publicKey: "abc" }, provider: provider({}), demoMode: false });
    const htmlUnlocked = renderSettings(unlocked);
    expect(htmlUnlocked).toContain('id="change-new-password"');
    expect(htmlUnlocked).toContain('id="change-word-1"');
    expect(htmlUnlocked).not.toContain('id="change-old-password"');
    expect(htmlUnlocked).not.toContain('id="switch-word-1"');
    expect(htmlUnlocked).not.toContain('id="switch-password"');
  });

  it("Login page shows account cards when accounts exist", () => {
    const state = {
      ...createInitialState(),
      view: "login" as const,
      accounts: [
        { accountId: "abc123", publicKey: "key1" },
        { accountId: "def456", publicKey: "key2" },
      ],
      authRequired: true,
    };
    const html = renderLogin(state);
    expect(html).toContain("Open Account");
    expect(html).toContain('data-action="account-select"');
    expect(html).toContain("abc123");
    expect(html).toContain("def456");
    expect(html).toContain("Recover / Add Account");
  });

  it("Login page shows first-run when no accounts", () => {
    const state = {
      ...createInitialState(),
      view: "login" as const,
      accounts: [],
      authRequired: false,
    };
    const html = renderLogin(state);
    expect(html).toContain("Welcome to OpenStore");
    expect(html).toContain("Create New Account");
    expect(html).toContain("Recover Existing Account");
  });

  it("outdated shared-manifest copy removed", () => {
    const state = dashboardState({ identity: { configured: true, unlocked: true, label: "local keystore", publicKey: "abc" }, provider: provider({}), demoMode: false });
    const html = renderSettings(state);
    expect(html).not.toContain("single-manifestDir");
    expect(html).not.toContain("manifests are currently shared");
  });

  it("Dashboard provider visibility semantically correct", () => {
    const sharing = dashboardState({ provider: provider({ lifecycle: "sharing" as unknown as ProviderStatus["lifecycle"], state: "running", readiness: "ready" as unknown as ProviderStatus["readiness"] }), demoMode: false });
    const htmlSharing = renderDashboard(sharing, dashboardStats(sharing));
    expect(htmlSharing).toContain("My Storage Share");
    expect(htmlSharing).toContain("available");

    const draining = dashboardState({ provider: provider({ lifecycle: "draining" as unknown as ProviderStatus["lifecycle"], state: "draining", readiness: "draining" as unknown as ProviderStatus["readiness"] }), demoMode: false });
    const htmlDraining = renderDashboard(draining, dashboardStats(draining));
    expect(htmlDraining).toContain("Storage sharing is draining");

    const released = dashboardState({ provider: provider({ lifecycle: "released" as unknown as ProviderStatus["lifecycle"], state: "released", readiness: "released" as unknown as ProviderStatus["readiness"] }), demoMode: false });
    const htmlReleased = renderDashboard(released, dashboardStats(released));
    expect(htmlReleased).toContain("Not sharing");

    const notConfigured = dashboardState({ provider: provider({ configured: false, state: "unconfigured", lifecycle: "unconfigured" as unknown as ProviderStatus["lifecycle"] }), demoMode: false });
    const htmlNotConfigured = renderDashboard(notConfigured, dashboardStats(notConfigured));
    expect(htmlNotConfigured).toContain("Not configured");
  });

  it("provider visibility does not imply sharing when not eligible", () => {
    const notEligible = dashboardState({ provider: provider({ lifecycle: "released" as unknown as ProviderStatus["lifecycle"], state: "released", placementEligible: false, readiness: "released" as unknown as ProviderStatus["readiness"] }), demoMode: false, nodes: [{ id: "n1", baseUrl: "http://a", available: true, allocatedBytes: 1000, usedBytes: 0, availableBytes: 1000, score: 80, storageScore: 70, lastSeen: Date.now() }] });
    const html = renderDashboard(notEligible, dashboardStats(notEligible));
    expect(html).toContain("Not sharing");
  });

  it("Login page renders inside renderApp when view is login", () => {
    const state = {
      ...createInitialState(),
      view: "login" as const,
      accounts: [{ accountId: "aaa", publicKey: "k1" }],
      authRequired: true,
    };
    const html = renderApp(state, dashboardStats(state));
    expect(html).toContain("Open Account");
    expect(html).toContain("Account selection");
    expect(html).not.toContain("Dashboard</h2>");
  });

  it("no Lock Account or identity-lock in rendered app", () => {
    const state = dashboardState({ identity: { configured: true, unlocked: true, label: "local keystore", publicKey: "abc" }, provider: provider({}), demoMode: false });
    const html = renderApp(state, dashboardStats(state));
    expect(html).not.toContain("Lock Account");
    expect(html).not.toContain('data-action="identity-lock"');
  });
});
