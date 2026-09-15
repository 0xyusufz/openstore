import { describe, expect, it } from "vitest";
import {
  attemptDelete,
  attemptDownload,
  attemptUpload,
  createInitialState,
  dashboardStats,
  dismissNotice,
  downloadComplete,
  downloadDecrypting,
  downloadDownloading,
  downloadFailed,
  downloadLocating,
  identityCreationDismissed,
  identityCreationReceived,
  identityLocked,
  identityUnlocked,
  navigate,
  parseHash,
  resetUploadDraft,
  retryDownload,
  retryUpload,
  selectFileForUpload,
  toggleRecoveryPhraseReveal,
  uploadComplete,
  uploadEncrypting,
  uploadFailed,
  uploadPreparing,
} from "./store.js";

describe("web UI store", () => {
  it("starts from mock data in demo mode", () => {
    const state = createInitialState();
    expect(state.view).toBe("dashboard");
    expect(state.demoMode).toBe(true);
    expect(state.files.length).toBeGreaterThan(0);
    expect(state.nodes.length).toBeGreaterThan(0);
    expect(state.notice).toBeNull();
  });

  it("parses hashes and navigates", () => {
    expect(parseHash("#/files")).toBe("files");
    expect(parseHash("#/upload")).toBe("upload");
    expect(parseHash("#/nodes")).toBe("nodes");
    expect(parseHash("#/settings")).toBe("settings");
    expect(parseHash("#/nope")).toBe("dashboard");
    expect(parseHash("")).toBe("dashboard");
    const moved = navigate(createInitialState(), "nodes");
    expect(moved.view).toBe("nodes");
  });

  it("stages uploads without reading contents, progresses through states", () => {
    let state = createInitialState();
    const fileCount = state.files.length;
    state = selectFileForUpload(state, "report.pdf", 1024);
    expect(state.upload.status).toBe("ready");
    expect(state.upload.fileName).toBe("report.pdf");
    expect(state.files).toHaveLength(fileCount);

    state = attemptUpload(state);
    expect(state.upload.status).toBe("preparing");
    expect(state.files).toHaveLength(fileCount);
    expect(state.notice).toBeNull();

    state = uploadPreparing(state);
    expect(state.upload.status).toBe("encrypting");

    state = uploadEncrypting(state);
    expect(state.upload.status).toBe("storing");

    state = uploadComplete(state, { fileId: "abc123", filename: "report.pdf", size: 1024, totalChunks: 1 });
    expect(state.upload.status).toBe("complete");
    expect(state.upload.fileName).toBe("report.pdf");

    state = uploadFailed(state, "node unreachable");
    expect(state.upload.status).toBe("failed");
    expect(state.upload.note).toMatch(/node unreachable/i);

    // Upload with nothing staged asks for a file first
    const idle = attemptUpload(createInitialState());
    expect(idle.notice).toMatch(/select a file/i);

    // Duplicate submission is impossible: only a "ready" draft starts an
    // upload; every other state is a no-op returning the same state.
    const ready = selectFileForUpload(createInitialState(), "dup.bin", 10);
    const active = attemptUpload(ready);
    expect(active.upload.status).toBe("preparing");
    expect(attemptUpload(active)).toBe(active);
    const encrypting = uploadPreparing(active);
    const storing = uploadEncrypting(encrypting);
    expect(attemptUpload(storing)).toBe(storing);
    const done = uploadComplete(storing, { fileId: "x", filename: "dup.bin", size: 10, totalChunks: 1 });
    expect(attemptUpload(done)).toBe(done);
    const failed = uploadFailed(storing, "boom");
    expect(attemptUpload(failed)).toBe(failed);

    // Invalid staging is rejected clearly
    expect(selectFileForUpload(createInitialState(), "", 10).notice).toMatch(/valid file/i);
    expect(dismissNotice(state).notice).toBeNull();
    expect(resetUploadDraft(state).upload.status).toBe("idle");
  });

  it("deletes never mutate files", () => {
    let state = createInitialState();
    const fileId = state.files[0]?.fileId as string;
    const snapshot = state.files.map((f) => f.fileId);

    state = attemptDelete(state, fileId);
    expect(state.files.map((f) => f.fileId)).toEqual(snapshot);
    expect(state.notice).toMatch(/not performed/i);

    expect(attemptDelete(state, "missing-id").notice).toMatch(/no file/i);
  });

  it("downloads start an active flow without touching files", () => {
    let state = createInitialState();
    const file = state.files[0]!;
    const snapshot = state.files.map((f) => f.fileId);

    state = attemptDownload(state, file.fileId);
    expect(state.files.map((f) => f.fileId)).toEqual(snapshot);
    expect(state.download.status).toBe("locating");
    expect(state.download.fileId).toBe(file.fileId);
    expect(state.download.filename).toBe(file.filename);
    expect(state.notice).toBeNull();

    // Duplicate attempts while locating/downloading are a no-op
    expect(attemptDownload(state, file.fileId)).toBe(state);

    // Locating → downloading → decrypting → verifying chain
    state = downloadLocating(state);
    expect(state.download.status).toBe("downloading");
    state = downloadDownloading(state);
    expect(state.download.status).toBe("decrypting");
    state = downloadDecrypting(state);
    expect(state.download.status).toBe("verifying");

    state = downloadComplete(state, { fileId: file.fileId, filename: file.filename, size: 12 });
    expect(state.download.status).toBe("complete");
    expect(state.download.note).toContain(file.filename);

    state = downloadFailed(state, "node unreachable");
    expect(state.download.status).toBe("failed");
    expect(state.download.note).toMatch(/temporarily unavailable|node unreachable/i);

    // A finished flow accepts a fresh download; unknown IDs warn cleanly.
    const retry = attemptDownload(state, file.fileId);
    expect(retry.download.status).toBe("locating");
    expect(attemptDownload(state, "missing-id").notice).toMatch(/no file/i);
  });

  it("computes dashboard aggregates", () => {
    const stats = dashboardStats(createInitialState());
    expect(stats.fileCount).toBe(3);
    expect(stats.nodeCount).toBe(3);
    expect(stats.nodesOnline).toBe(2);
    expect(stats.bytesUsed).toBe(402_653_184 + 134_217_728 + 66_060_288);
    expect(stats.bytesAllocated).toBe(1_073_741_824 * 2 + 536_870_912);
    expect(stats.bytesAvailable).toBe(stats.bytesAllocated - stats.bytesUsed);
    expect(stats.avgScore).toBe(Math.round((92 + 74 + 41) / 3));
  });

  it("tracks transient identity creation without persisting it", () => {
    const phrase = ["alpha", "bravo", "charlie"];
    const created = identityCreationReceived(createInitialState(), { publicKey: "cHVi", recoveryPhrase: phrase });
    expect(created.identity.configured).toBe(true);
    expect(created.identity.unlocked).toBe(true);
    expect(created.identityCreation?.recoveryPhrase).toEqual(phrase);
    // Copied, not referenced
    expect(created.identityCreation?.recoveryPhrase).not.toBe(phrase);

    const dismissed = identityCreationDismissed(created);
    expect(dismissed.identityCreation).toBeNull();
    expect(dismissed.identity.configured).toBe(true);

    expect(() => identityCreationReceived(createInitialState(), null as never)).toThrow(/creation/i);
  });

  it("reflects unlock and lock transitions", () => {
    const unlocked = identityUnlocked(createInitialState(), "cHVi");
    expect(unlocked.identity.unlocked).toBe(true);
    expect(unlocked.identity.configured).toBe(true);
    expect(unlocked.identity.publicKey).toBe("cHVi");

    const locked = identityLocked(unlocked);
    expect(locked.identity.unlocked).toBe(false);
    expect(locked.identity.publicKey).toBe("cHVi");

    expect(() => identityUnlocked(createInitialState(), "")).toThrow(/publicKey/i);
  });

  it("recovery phrase reveal toggles correctly", () => {
    const withCreation = identityCreationReceived(createInitialState(), {
      publicKey: "cHVi",
      recoveryPhrase: ["alpha", "bravo"],
    });
    expect(withCreation.recoveryPhraseRevealed).toBe(false);

    const revealed = toggleRecoveryPhraseReveal(withCreation);
    expect(revealed.recoveryPhraseRevealed).toBe(true);

    const maskedAgain = toggleRecoveryPhraseReveal(revealed);
    expect(maskedAgain.recoveryPhraseRevealed).toBe(false);
  });

  it("identityCreationDismissed clears reveal flag", () => {
    const withCreation = identityCreationReceived(createInitialState(), {
      publicKey: "cHVi",
      recoveryPhrase: ["alpha", "bravo"],
    });
    const revealed = toggleRecoveryPhraseReveal(withCreation);
    expect(revealed.recoveryPhraseRevealed).toBe(true);
    const dismissed = identityCreationDismissed(revealed);
    expect(dismissed.identityCreation).toBeNull();
    expect(dismissed.recoveryPhraseRevealed).toBe(false);
  });
});
