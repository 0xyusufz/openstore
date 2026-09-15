import { describe, expect, it } from "vitest";
import {
  attemptDelete,
  attemptDownload,
  attemptUpload,
  createInitialState,
  dashboardStats,
  dismissNotice,
  navigate,
  parseHash,
  resetUploadDraft,
  selectFileForUpload,
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

  it("stages uploads without reading contents, never reports success", () => {
    let state = createInitialState();
    const fileCount = state.files.length;
    state = selectFileForUpload(state, "report.pdf", 1024);
    expect(state.upload.status).toBe("ready");
    expect(state.upload.fileName).toBe("report.pdf");
    expect(state.files).toHaveLength(fileCount);

    state = attemptUpload(state);
    expect(state.upload.status).toBe("blocked");
    expect(state.files).toHaveLength(fileCount);
    expect(state.notice).toMatch(/not performed/i);

    // Upload with nothing staged asks for a file first
    const idle = attemptUpload(createInitialState());
    expect(idle.notice).toMatch(/select a file/i);

    // Invalid staging is rejected clearly
    expect(selectFileForUpload(createInitialState(), "", 10).notice).toMatch(/valid file/i);
    expect(dismissNotice(state).notice).toBeNull();
    expect(resetUploadDraft(state).upload.status).toBe("idle");
  });

  it("deletes and downloads never mutate files", () => {
    let state = createInitialState();
    const fileId = state.files[0]?.fileId as string;
    const snapshot = state.files.map((f) => f.fileId);

    state = attemptDelete(state, fileId);
    expect(state.files.map((f) => f.fileId)).toEqual(snapshot);
    expect(state.notice).toMatch(/not performed/i);

    state = attemptDownload(state, fileId);
    expect(state.files.map((f) => f.fileId)).toEqual(snapshot);
    expect(state.notice).toMatch(/not performed/i);

    expect(attemptDelete(state, "missing-id").notice).toMatch(/no file/i);
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
});
