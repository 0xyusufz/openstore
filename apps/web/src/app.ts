/**
 * OpenStore Web Frontend — DOM bootstrap (OPENSTORE-023).
 *
 * Thin imperative shell around the pure store/views modules: hash
 * routing, event delegation, and re-rendering. File inputs expose only
 * name/size — contents are never read.
 */

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
import type { WebState } from "./store.js";
import { renderApp } from "./views.js";

function mount(): HTMLElement | null {
  return document.getElementById("app");
}

function render(state: WebState): void {
  const root = mount();
  if (!root) return;
  root.innerHTML = renderApp(state, dashboardStats(state));
}

function syncFromHash(state: WebState): WebState {
  return navigate(state, parseHash(window.location.hash));
}

export function startApp(): void {
  let state: WebState = syncFromHash(createInitialState());
  render(state);

  window.addEventListener("hashchange", () => {
    state = syncFromHash(state);
    render(state);
  });

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest?.("[data-action]") as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.getAttribute("data-action");
    if (action === "notice-dismiss") {
      state = dismissNotice(state);
      render(state);
    } else if (action === "upload-attempt") {
      state = attemptUpload(state);
      render(state);
    } else if (action === "delete-attempt" || action === "download-attempt") {
      const fileId = actionEl.getAttribute("data-file-id") ?? "";
      state = action === "delete-attempt" ? attemptDelete(state, fileId) : attemptDownload(state, fileId);
      render(state);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id === "upload-input" && target instanceof HTMLInputElement) {
      const picked = target.files?.[0];
      if (picked) {
        // Name + size only. Contents are never read in this demo build.
        state = resetUploadDraft(selectFileForUpload(state, picked.name, picked.size));
        render(state);
      }
    }
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
  } else {
    startApp();
  }
}
