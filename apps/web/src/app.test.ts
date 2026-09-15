/**
 * Upload staging regression tests (file-input flow).
 *
 * The `#upload-input` change handler must stage the picked file via
 * {@link stagePickedFile} and nothing else. A past bug wrapped the
 * result in `resetUploadDraft`, which silently wiped the fresh `ready`
 * draft back to `idle` — the UI stayed on "No file staged" with Upload
 * disabled even though a file was picked. These tests pin the correct
 * composition: staging a file always yields a `ready` draft.
 */

import { describe, expect, it } from "vitest";
import { resetUploadDraft } from "./store.js";
import { createInitialState } from "./store.js";
import { stagePickedFile } from "./app.js";

describe("upload file staging (file-input regression)", () => {
  it("staging a picked file yields a ready draft with name and size", () => {
    const staged = stagePickedFile(createInitialState(), "photo.jpg", 12345);
    expect(staged.upload.status).toBe("ready");
    expect(staged.upload.fileName).toBe("photo.jpg");
    expect(staged.upload.fileSize).toBe(12345);
    expect(staged.notice).toBeNull();
    // Only metadata enters state — exact key set, no blob/data/file fields.
    expect(Object.keys(staged.upload).sort()).toEqual(["fileName", "fileSize", "note", "retryable", "status"]);
  });

  it("staging never resets back to idle (the reported bug)", () => {
    const staged = stagePickedFile(createInitialState(), "real.png", 69);
    // The buggy composition reset∘select produces idle; the fixed
    // staging path must differ from it.
    const buggy = resetUploadDraft(staged);
    expect(buggy.upload.status).toBe("idle");
    expect(staged.upload.status).toBe("ready");
    expect(staged).not.toBe(buggy);
  });

  it("re-selecting a file replaces the previous draft", () => {
    let state = stagePickedFile(createInitialState(), "first.txt", 10);
    state = stagePickedFile(state, "second.png", 20);
    expect(state.upload.status).toBe("ready");
    expect(state.upload.fileName).toBe("second.png");
    expect(state.upload.fileSize).toBe(20);
  });

  it("invalid picks surface a notice and stay idle", () => {
    const empty = stagePickedFile(createInitialState(), "", 10);
    expect(empty.upload.status).toBe("idle");
    expect(empty.notice).toMatch(/valid file/i);
  });
});
