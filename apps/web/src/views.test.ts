import { describe, expect, it } from "vitest";
import {
  attemptUpload,
  createInitialState,
  dashboardStats,
  identityCreationReceived,
  identityLocked,
  identityUnlocked,
  navigate,
  selectFileForUpload,
  toggleRecoveryPhraseReveal,
  uploadEncrypting,
} from "./store.js";
import { renderApp, renderDashboard, renderFiles, renderNodes, renderSettings, renderUpload } from "./views.js";

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

  it("upload button is disabled while an upload is active", () => {
    const ready = selectFileForUpload(createInitialState(), "dup.bin", 10);
    expect(renderUpload(ready)).not.toContain("disabled");
    const encrypting = attemptUpload(ready);
    expect(renderUpload(encrypting)).toContain("disabled");
    expect(renderUpload(encrypting)).toContain("Encrypting...");
    const storing = uploadEncrypting(encrypting);
    expect(renderUpload(storing)).toContain("disabled");
    expect(renderUpload(storing)).toContain("Storing replicas...");
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

  it("settings shows creation, unlock, and lock states safely", () => {
    // Unconfigured: creation form, password fields with show/hide toggles
    const fresh = renderSettings(createInitialState());
    expect(fresh).toContain('id="identity-create-form"');
    expect(fresh).toContain('type="password"');
    expect(fresh).not.toContain("value=");
    expect(fresh).toContain('data-action="toggle-password"');

    // Creation result: phrase masked by default, warning, reveal/copy buttons
    const created = identityCreationReceived(createInitialState(), {
      publicKey: "cHVi",
      recoveryPhrase: ["alpha", "bravo"],
    });
    const creationHtml = renderSettings(created);
    expect(creationHtml).toContain("••••••••");
    expect(creationHtml).not.toContain(">alpha<");
    expect(creationHtml).not.toContain(">bravo<");
    expect(creationHtml).toMatch(/only time|back up/i);
    expect(creationHtml).toContain('data-action="reveal-phrase"');
    expect(creationHtml).toContain('data-action="copy-phrase"');
    expect(creationHtml).toContain('data-action="creation-dismiss"');
    expect(creationHtml).not.toContain("privateKey");

    // When revealed, words appear
    const revealedState = toggleRecoveryPhraseReveal(created);
    expect(revealedState.recoveryPhraseRevealed).toBe(true);
    const revealedHtml = renderSettings(revealedState);
    expect(revealedHtml).toContain(">alpha<");
    expect(revealedHtml).toContain(">bravo<");
    expect(revealedHtml).toContain("Hide phrase");

    // Locked: unlock form with password toggle
    const locked = identityLocked(identityUnlocked(createInitialState(), "cHVi"));
    const lockedHtml = renderSettings(locked);
    expect(lockedHtml).toContain('id="identity-unlock-form"');
    expect(lockedHtml).toContain('data-action="toggle-password"');

    // Unlocked: lock button, truncated public key
    const unlockedHtml = renderSettings(identityUnlocked(createInitialState(), "cHVi"));
    expect(unlockedHtml).toContain('data-action="identity-lock"');
    expect(unlockedHtml).toContain("cHVi");
  });

  it("recovery form has masked word inputs with reveal toggles and paste hint", () => {
    const html = renderSettings(createInitialState());
    expect(html).toContain('id="identity-recover-form"');
    expect(html).toContain('data-word-input="1"');
    expect(html).toContain('data-action="toggle-word-reveal"');
    expect(html).toContain('type="password"');
    expect(html).toContain("paste all words at once");
    expect(html).toContain('id="phrase-validation-error"');
  });
});
