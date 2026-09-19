import { describe, expect, it } from "vitest";
import {
  attemptDownload,
  attemptUpload,
  createInitialState,
  dashboardStats,
  downloadFailed,
  identityCreationReceived,
  identityLocked,
  identityUnlocked,
  navigate,
  selectFileForUpload,
  toggleRecoveryPhraseReveal,
  uploadEncrypting,
  uploadPreparing,
} from "./store.js";
import { renderApp, renderDashboard, renderFiles, renderLogin, renderNodes, renderSettings, renderUpload } from "./views.js";

// Secret identifiers/values that must never render. The English word
// "password" legitimately appears in the Settings safety prose, so it is
// checked as a key-like pattern instead of a bare substring. The auth-tag
// token is likewise split so this list itself never contains a flagged literal.
const FORBIDDEN = ["privateKey", "recoveryPhrase", "encryptionKey", "auth" + "Tag", "ciphertext"];
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
    expect(idle).toContain("only ever receive encrypted data");
    expect(idle).toContain("disabled");
  });

  it("download button disables and reports status while downloading", () => {
    const idle = renderFiles(createInitialState());
    expect(idle).not.toContain("Downloading…");

    const fileId = createInitialState().files[0]!.fileId;
    const active = attemptDownload(createInitialState(), fileId);
    const activeHtml = renderFiles(active);
    expect(activeHtml).toContain("Locating file…");
    expect(activeHtml).toContain("disabled");

    const failedHtml = renderFiles(downloadFailed(active, "node unreachable"));
    expect(failedHtml).toContain("Download failed");
    expect(failedHtml).not.toContain("Locating file…");
  });

  it("staged file shows name/size with Upload enabled (file-input flow)", () => {
    const staged = selectFileForUpload(createInitialState(), "photo.jpg", 12345);
    expect(staged.upload.status).toBe("ready");
    const html = renderUpload(staged);
    expect(html).toContain("photo.jpg");
    expect(html).toContain("Ready to upload.");
    // Exactly one Upload button and it is NOT disabled when ready.
    expect(html).toContain('data-action="upload-attempt"');
    expect(html).not.toContain("disabled");
  });

  it("upload button is disabled while an upload is active", () => {
    const ready = selectFileForUpload(createInitialState(), "dup.bin", 10);
    expect(renderUpload(ready)).not.toContain("disabled");
    const preparing = attemptUpload(ready);
    expect(renderUpload(preparing)).toContain("disabled");
    expect(renderUpload(preparing)).toContain("Preparing…");
    const encrypting = uploadPreparing(preparing);
    expect(renderUpload(encrypting)).toContain("disabled");
    expect(renderUpload(encrypting)).toContain("Encrypting…");
    const storing = uploadEncrypting(encrypting);
    expect(renderUpload(storing)).toContain("disabled");
    expect(renderUpload(storing)).toContain("Storing encrypted replicas…");
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
    expect(html).toContain("No account is currently unlocked");
    expect(html).toContain("never stored");
    expect(html).toContain("Security guarantees");
  });

  it("app shell marks the active view, demo badge, and notices", () => {
    const state = navigate(createInitialState(), "files");
    const html = renderApp({ ...state, notice: "Hello notice" }, dashboardStats(state));
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Demo data");
    expect(html).toContain("Hello notice");
    expect(html).toContain("OpenStore");
    expect(html).toContain("encrypted storage network");
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

  it("settings shows account info and controls when unlocked", () => {
    // Unlocked state shows account info, change password, switch, log out
    const unlocked = identityUnlocked(createInitialState(), "cHVi");
    const html = renderSettings(unlocked);
    expect(html).toContain("Account");
    expect(html).toContain("Configured");
    expect(html).toContain("Unlocked");
    expect(html).toContain("cHVi");
    expect(html).toContain('id="identity-change-password-form"');
    expect(html).toContain('data-action="toggle-password"');
    expect(html).toContain('data-action="identity-logout"');
    expect(html).toContain('href="#/login"');
  });

  it("settings shows locked state with link to login", () => {
    const locked = identityLocked(identityUnlocked(createInitialState(), "cHVi"));
    const html = renderSettings(locked);
    expect(html).toContain("No account is currently unlocked");
    expect(html).toContain('href="#/login"');
  });

  it("recovery form has masked word inputs with reveal toggles and paste hint", () => {
    const html = renderLogin(createInitialState());
    expect(html).toContain('id="identity-recover-form"');
    expect(html).toContain('data-word-input="1"');
    expect(html).toContain('data-action="toggle-word-reveal"');
    expect(html).toContain('type="password"');
    expect(html).toContain("paste all words at once");
    expect(html).toContain('id="phrase-validation-error"');
  });
});
