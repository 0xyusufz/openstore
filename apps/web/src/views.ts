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
  const progressPct =
    draft.status === "encrypting" ? 25 :
    draft.status === "storing" ? 60 :
    draft.status === "complete" ? 100 :
    draft.status === "failed" ? 100 : 0;
  const progressLabel =
    draft.status === "encrypting" ? "Encrypting..." :
    draft.status === "storing" ? "Storing replicas..." :
    draft.status === "complete" ? "Complete" :
    draft.status === "failed" ? "Failed" : "";
  const staged =
    draft.status === "idle"
      ? `<p class="muted">No file staged.</p>`
      : `<div class="staged">
          <p><strong>${esc(draft.fileName)}</strong> (${esc(formatBytes(draft.fileSize))})</p>
          ${draft.note ? `<p class="muted">${esc(draft.note)}</p>` : ""}
          ${draft.status !== "ready" ? `
          <div class="progress" role="progressbar" aria-valuenow="${progressPct}" aria-valuemin="0" aria-valuemax="100">
            <span class="progress-fill${draft.status === "complete" ? " progress-good" : draft.status === "failed" ? " progress-bad" : ""}" style="width:${progressPct}%"></span>
          </div>
          <p class="muted">${esc(progressLabel)}</p>` : ""}
          ${draft.status === "ready" ? `<p class="muted">Ready to upload.</p>` : ""}
          ${draft.status === "complete" ? `<p class="muted">File encrypted, chunked, and stored on nodes.</p>` : ""}
          ${draft.status === "failed" ? `<p class="muted">Upload failed. Check that storage nodes are running.</p>` : ""}
        </div>`;
  return `
  <section aria-label="Upload">
    <h2>Upload</h2>
    <p class="muted">Pick a file to upload. Your browser sends it to the client backend on this server, which encrypts and chunks it before storage — storage nodes only ever receive encrypted data.</p>
    <div class="upload-box">
      <label class="file-label">Choose file
        <input id="upload-input" type="file" />
      </label>
      ${staged}
      <div class="row">
        <button type="button" data-action="upload-attempt" ${draft.status === "idle" || draft.status === "encrypting" || draft.status === "storing" ? "disabled" : ""}>Upload</button>
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
    const revealed = state.recoveryPhraseRevealed;
    const words = state.identityCreation.recoveryPhrase
      .map(
        (word, index) =>
          `<li><span class="word-index">${index + 1}</span> <span class="${revealed ? "word-revealed" : "word-masked"}">${revealed ? esc(word) : "••••••••"}</span></li>`,
      )
      .join("");
    return `
  <section aria-label="Settings">
    <h2>Settings</h2>
    <div class="card">
      <h3>Back up your recovery phrase</h3>
      <p class="warning" role="alert"><strong>Write these ${state.identityCreation.recoveryPhrase.length} words down now.</strong>
      If you lose both your password AND this phrase, your identity is permanently unrecoverable.
      This is the only time they are shown. They are never stored on disk and cannot be recovered if lost.
      Never share them with anyone.</p>
      <ol class="phrase">${words}</ol>
      <div class="phrase-actions">
        <button type="button" data-action="reveal-phrase" class="btn-copy">${revealed ? "Hide phrase" : "Reveal phrase"}</button>
        <button type="button" data-action="copy-phrase" class="btn-copy">Copy phrase</button>
      </div>
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
        <div class="form-row"><label>Password
          <div class="input-wrap"><input id="create-password" name="password" type="password" autocomplete="new-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="create-password" class="btn-reveal">Show</button></div>
        </label></div>
        <div class="form-row"><label>Confirm password
          <div class="input-wrap"><input id="create-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="create-confirm" class="btn-reveal">Show</button></div>
        </label></div>
        <div class="row"><button type="submit">Create identity</button></div>
      </form>`
    : !state.identity.unlocked
      ? `<form id="identity-unlock-form" autocomplete="off">
          <h3>Unlock keystore</h3>
          <div class="form-row"><label>Password
            <div class="input-wrap"><input id="unlock-password" name="password" type="password" autocomplete="current-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="unlock-password" class="btn-reveal">Show</button></div>
          </label></div>
          <div class="row"><button type="submit">Unlock</button></div>
        </form>`
      : `<div class="row"><button type="button" data-action="identity-lock">Lock identity</button></div>`;
  const wordInputs = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    return `<div class="form-row phrase-input"><label>${n}
      <div class="input-wrap"><input id="recovery-word-${n}" name="word${n}" type="password" autocomplete="off" required minlength="1" placeholder="word ${n}" data-word-input="${n}" /><button type="button" data-action="toggle-word-reveal" data-word-slot="${n}" class="btn-reveal">Show</button></div>
    </label></div>`;
  }).join("");
  const recoveryForm = `<form id="identity-recover-form" autocomplete="off">
        <h3>Recover from phrase</h3>
        <p class="muted">Enter your 12-word recovery phrase. You can paste all words at once into any field.</p>
        <div id="phrase-validation-error" class="validation-error" hidden></div>
        <div class="phrase-inputs">${wordInputs}</div>
        <div class="form-row"><label>New password
          <div class="input-wrap"><input id="recover-password" name="password" type="password" autocomplete="new-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="recover-password" class="btn-reveal">Show</button></div>
        </label></div>
        <div class="form-row"><label>Confirm password
          <div class="input-wrap"><input id="recover-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="1" /><button type="button" data-action="toggle-password" data-target="recover-confirm" class="btn-reveal">Show</button></div>
        </label></div>
        ${state.identity.configured ? `<div class="form-row"><label class="checkbox-label"><input id="recover-confirm-replace" type="checkbox" /> Replace existing keystore</label></div>` : ""}
        <div class="row"><button type="submit">Recover identity</button></div>
      </form>`;
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
      If you lose both your password and recovery phrase, your identity is permanently unrecoverable.
      Identity management requires a server started with identity support; otherwise these actions report an error.</p>
    </div>
    <div class="card">
      ${recoveryForm}
    </div>
    <div class="card">
      <h3>Security guarantees</h3>
      <ul>
        <li>Client-side encryption stays in the audited library packages.</li>
        <li>This dashboard renders metadata only — never file contents, private keys, or encryption keys.</li>
        <li>Recovery phrases are shown once during creation, then immediately cleared from memory.</li>
        <li>Passwords are never stored — not in this page, not in the backend, nowhere.</li>
        <li>If you lose both your password and recovery phrase, your identity is permanently unrecoverable.</li>
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
  <footer class="footer"><span>OpenStore dashboard — encrypted storage network.</span></footer>`;
}
