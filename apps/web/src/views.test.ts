import { describe, expect, it } from "vitest";
import { createInitialState, dashboardStats, navigate } from "./store.js";
import { renderApp, renderDashboard, renderFiles, renderNodes, renderSettings, renderUpload } from "./views.js";

// Secret identifiers/values that must never render. The English word
// "password" legitimately appears in the Settings safety prose, so it is
// checked as a key-like pattern instead of a bare substring.
const FORBIDDEN = ["privateKey", "recoveryPhrase", "encryptionKey", "authTag", "ciphertext"];
const PASSWORD_KV_PATTERN = /["']password["']\s*[:=]/i;

describe("web views", () => {
  it("dashboard renders storage, nodes, and health summary", () => {
    const state = createInitialState();
    const html = renderDashboard(state, dashboardStats(state));
    expect(html).toContain("Dashboard");
    expect(html).toContain("2/3 online");
    expect(html).toContain("575.0 MB"); // summed mock used bytes
    expect(html).toContain("2.5 GB"); // summed mock allocated bytes
    expect(html).toContain("avg reliability 69 · Fair");
  });

  it("files view lists safe metadata with actions", () => {
    const html = renderFiles(createInitialState());
    expect(html).toContain("project-backup.zip");
    expect(html).toContain("12.0 MB");
    expect(html).toContain("family-photos.tar");
    expect(html).toContain('data-action="download-attempt"');
    expect(html).toContain('data-action="delete-attempt"');
    expect(html).toContain("never appear here");
  });

  it("upload view stages honestly without claiming success", () => {
    const idle = renderUpload(createInitialState());
    expect(idle).toContain("No file staged");
    expect(idle).toContain("never the contents");
    expect(idle).toContain("disabled");
  });

  it("nodes view shows capacity and both health scores", () => {
    const html = renderNodes(createInitialState());
    expect(html).toContain("http://127.0.0.1:4101");
    expect(html).toContain("Online");
    expect(html).toContain("Offline");
    expect(html).toContain("Reliability");
    expect(html).toContain("Storage health");
  });

  it("settings view discloses identity limits", () => {
    const html = renderSettings(createInitialState());
    expect(html).toContain("Not configured");
    expect(html).toContain("never handles private keys");
  });

  it("app shell marks the active view, demo badge, and notices", () => {
    const state = navigate(createInitialState(), "files");
    const html = renderApp({ ...state, notice: "Hello notice" }, dashboardStats(state));
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Demo data");
    expect(html).toContain("Hello notice");
    expect(html).toContain("OpenStore");
    expect(html).toContain("mock data, no real operations");
  });

  it("no view leaks secrets", () => {
    const state = createInitialState();
    const stats = dashboardStats(state);
    const pages = [
      renderApp(state, stats),
      renderApp(navigate(state, "files"), stats),
      renderApp(navigate(state, "upload"), stats),
      renderApp(navigate(state, "nodes"), stats),
      renderApp(navigate(state, "settings"), stats),
    ];
    for (const html of pages) {
      for (const secret of FORBIDDEN) {
        expect(html).not.toContain(secret);
      }
      expect(html).not.toMatch(PASSWORD_KV_PATTERN);
    }
  });

  it("dynamic content is escaped", () => {
    const state = createInitialState();
    const evil = { ...state.files[0]!, filename: '<img src=x onerror="1">', fileId: "demo-evil" };
    const html = renderFiles({ ...state, files: [evil] });
    expect(html).not.toContain('<img src=x onerror="1">');
    expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
  });
});
