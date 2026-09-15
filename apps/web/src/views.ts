/**
 * OpenStore Web Frontend — pure view renderers (OPENSTORE-023).
 *
 * Every screen is a pure function of {@link WebState} returning an HTML
 * string. Dynamic content is escaped; only safe metadata is rendered.
 * No uploads, deletes, or downloads are performed or faked here.
 */

import { availabilityLabel, esc, formatBytes, formatDateTime, healthGrade, truncateId } from "./format.js";
import { VIEWS } from "./store.js";
import type { ViewId, WebState } from "./store.js";
import type { DashboardStats } from "./types.js";

function navHtml(active: ViewId): string {
  const links = VIEWS.map(
    (v) =>
      `<a href="${v.hash}" data-nav="${v.id}" class="nav-link${v.id === active ? " active" : ""}"${
        v.id === active ? ' aria-current="page"' : ""
      }>${esc(v.label)}</a>`,
  ).join("");
  return `<nav class="nav" aria-label="Primary">${links}</nav>`;
}

function noticeHtml(notice: string | null): string {
  if (!notice) return "";
  return `<div class="notice" role="status"><span>${esc(notice)}</span><button type="button" data-action="notice-dismiss">Dismiss</button></div>`;
}

function scoreBar(score: number): string {
  const grade = healthGrade(score);
  const safe = Math.min(100, Math.max(0, Math.round(score)));
  return `<span class="score score-${grade.class}"><span class="score-bar" style="width:${safe}%"></span><span class="score-label">${safe} · ${esc(grade.label)}</span></span>`;
}

function capacityBar(used: number, allocated: number): string {
  const pct = allocated > 0 ? Math.min(100, Math.round((used / allocated) * 100)) : 0;
  return `<span class="meter"><span class="meter-fill" style="width:${pct}%"></span></span>`;
}

export function renderDashboard(state: WebState, stats: DashboardStats): string {
  const grade = healthGrade(stats.avgScore);
  return `
  <section aria-label="Storage overview">
    <h2>Dashboard</h2>
    <div class="cards">
      <div class="card"><h3>Storage used</h3><p class="stat">${esc(formatBytes(stats.bytesUsed))}</p><p class="sub">of ${esc(formatBytes(stats.bytesAllocated))} allocated</p></div>
      <div class="card"><h3>Available</h3><p class="stat">${esc(formatBytes(stats.bytesAvailable))}</p><p class="sub">${stats.fileCount} file(s) · ${stats.totalChunks} chunk(s)</p></div>
      <div class="card"><h3>Nodes</h3><p class="stat">${stats.nodesOnline}/${stats.nodeCount} online</p><p class="sub">avg reliability ${stats.avgScore} · ${esc(grade.label)}</p></div>
    </div>
  </section>`;
}

export function renderFiles(state: WebState): string {
  const rows =
    state.files.length === 0
      ? `<tr><td colspan="5" class="empty">No files yet. Uploads land here once the backend is connected.</td></tr>`
      : state.files
          .map(
            (f) => `<tr>
        <td data-label="Name">${esc(f.filename)}<br><span class="muted">${esc(truncateId(f.fileId, 18))}</span></td>
        <td data-label="Size">${esc(formatBytes(f.size))}</td>
        <td data-label="Chunks">${f.totalChunks}</td>
        <td data-label="Created">${esc(formatDateTime(f.createdAt ?? 0))}</td>
        <td data-label="Actions" class="actions">
          <button type="button" data-action="download-attempt" data-file-id="${esc(f.fileId)}">Download</button>
          <button type="button" data-action="delete-attempt" data-file-id="${esc(f.fileId)}" class="danger">Delete</button>
        </td>
      </tr>`,
          )
          .join("");
  return `
  <section aria-label="My files">
    <h2>My Files</h2>
    <p class="muted">Safe metadata only. File contents and keys never appear here.</p>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Size</th><th>Chunks</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

export function renderUpload(state: WebState): string {
  const draft = state.upload;
  const staged =
    draft.status === "idle"
      ? `<p class="muted">No file staged.</p>`
      : `<div class="staged">
          <p><strong>Staged:</strong> ${esc(draft.fileName)} (${esc(formatBytes(draft.fileSize))})</p>
          ${draft.note ? `<p class="muted">${esc(draft.note)}</p>` : ""}
          <div class="progress" aria-hidden="true"><span class="progress-fill" style="width:${draft.status === "blocked" ? 100 : 8}%"></span></div>
          <p class="muted">${draft.status === "blocked" ? "Not uploaded — see notice above." : "Ready when the backend is connected."}</p>
        </div>`;
  return `
  <section aria-label="Upload">
    <h2>Upload</h2>
    <p class="muted">Pick a file to stage it locally. Only the name and size are read — never the contents.</p>
    <div class="upload-box">
      <label class="file-label">Choose file
        <input id="upload-input" type="file" />
      </label>
      ${staged}
      <div class="row">
        <button type="button" data-action="upload-attempt" ${draft.status === "idle" ? "disabled" : ""}>Upload</button>
      </div>
    </div>
  </section>`;
}

export function renderNodes(state: WebState): string {
  const rows = state.nodes
    .map(
      (n) => `<tr>
      <td data-label="Node">${esc(truncateId(n.id, 16))}<br><span class="muted">${esc(n.baseUrl)}</span></td>
      <td data-label="Status"><span class="pill ${n.available ? "pill-on" : "pill-off"}">${esc(availabilityLabel(n.available))}</span></td>
      <td data-label="Capacity">${esc(formatBytes(n.usedBytes))} / ${esc(formatBytes(n.allocatedBytes))}${capacityBar(n.usedBytes, n.allocatedBytes)}</td>
      <td data-label="Reliability">${scoreBar(n.score)}</td>
      <td data-label="Storage health">${scoreBar(n.storageScore)}</td>
    </tr>`,
    )
    .join("");
  return `
  <section aria-label="Storage nodes">
    <h2>Storage Nodes</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Node</th><th>Status</th><th>Capacity</th><th>Reliability</th><th>Storage health</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

export function renderSettings(state: WebState): string {
  if (state.identityCreation) {
    const words = state.identityCreation.recoveryPhrase
      .map((word, index) => `<li><span class="word-index">${index + 1}</span> ${esc(word)}</li>`)
      .join("");
    return `
  <section aria-label="Settings">
    <h2>Settings</h2>
    <div class="card">
      <h3>Back up your recovery phrase</h3>
      <p class="warning" role="alert"><strong>Write these ${state.identityCreation.recoveryPhrase.length} words down now.</strong>
      This is the only time they are shown. They are never stored on disk and cannot be recovered if lost.
      Never share them with anyone.</p>
      <ol class="phrase">${words}</ol>
      <p class="muted">Public key: ${esc(truncateId(state.identityCreation.publicKey, 20))}</p>
      <div class="row"><button type="button" data-action="creation-dismiss">I have backed it up</button></div>
    </div>
  </section>`;
  }

  const statusLine = state.identity.configured
    ? state.identity.unlocked
      ? "Configured · <strong>Unlocked</strong>"
      : "Configured · <strong>Locked</strong>"
    : "<strong>Not configured</strong>";
  const publicKeyLine = state.identity.publicKey
    ? `<p class="muted">Public key: ${esc(truncateId(state.identity.publicKey, 20))}</p>`
    : "";
  const form = !state.identity.configured
    ? `<form id="identity-create-form" autocomplete="off">
        <h3>Create identity (first run)</h3>
        <div class="form-row"><label>Password <input id="create-password" name="password" type="password" autocomplete="new-password" required minlength="1" /></label></div>
        <div class="form-row"><label>Confirm password <input id="create-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="1" /></label></div>
        <div class="row"><button type="submit">Create identity</button></div>
      </form>`
    : !state.identity.unlocked
      ? `<form id="identity-unlock-form" autocomplete="off">
          <h3>Unlock keystore</h3>
          <div class="form-row"><label>Password <input id="unlock-password" name="password" type="password" autocomplete="current-password" required minlength="1" /></label></div>
          <div class="row"><button type="submit">Unlock</button></div>
        </form>`
      : `<div class="row"><button type="button" data-action="identity-lock">Lock identity</button></div>`;
  return `
  <section aria-label="Settings">
    <h2>Settings</h2>
    <div class="card">
      <h3>Local identity</h3>
      <p>Status: ${statusLine}</p>
      <p class="muted">Label: ${esc(state.identity.label)}</p>
      ${publicKeyLine}
      ${form}
      <p class="muted">Passwords are asked only when needed and never stored — not in this page, not in the backend, nowhere.
      Identity management requires a server started with identity support; otherwise these actions report an error.</p>
    </div>
    <div class="card">
      <h3>Security guarantees</h3>
      <ul>
        <li>Client-side encryption stays in the audited library packages.</li>
        <li>This dashboard renders metadata only — never file contents, private keys, or encryption keys.</li>
        <li>Uploads, downloads, and deletes are disabled until backend integration lands; the UI says so instead of faking success.</li>
      </ul>
    </div>
  </section>`;
}

/** Full app body for the current view (header nav + notice + screen). */
export function renderApp(state: WebState, stats: DashboardStats): string {
  const screen =
    state.view === "files"
      ? renderFiles(state)
      : state.view === "upload"
        ? renderUpload(state)
        : state.view === "nodes"
          ? renderNodes(state)
          : state.view === "settings"
            ? renderSettings(state)
            : renderDashboard(state, stats);
  return `
  <header class="topbar">
    <div class="brand"><span class="brand-mark" aria-hidden="true">◈</span> OpenStore</div>
    ${navHtml(state.view)}
    ${state.demoMode ? `<span class="demo-badge" title="All data on screen is local mock data">Demo data</span>` : `<span class="live-badge" title="Data served by the OpenStore web backend">Live</span>`}
  </header>
  <main id="view">${noticeHtml(state.notice)}${screen}</main>
  <footer class="footer"><span>OpenStore dashboard (demo build — mock data, no real operations).</span></footer>`;
}
