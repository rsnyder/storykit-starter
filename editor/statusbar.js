/**
 * editor/statusbar.js — status-bar controller (WP-5.1)
 *
 * Renders the §7 status bar: the GitHub binding (owner/repo · branch · path),
 * a five-state sync badge (local / synced / local-changes / remote-changed /
 * conflict — FR-GH.6), the live word count + cursor position, and the lint
 * count. It is a pure UI component: it owns the DOM inside its mount and reacts
 * to bus events + a small imperative API; it never touches the store or GitHub.
 *
 * Event consumption (MOVED here from app.js's former inline `wireStatusBar`):
 *   - 'editor:cursor'    { line, col }   → cursor readout
 *   - 'editor:wordcount' { words }       → word count
 *   - 'lint:count'       { count }       → lint readout
 *   - 'sync:status'      { docId, state, binding } → badge + binding (emitted
 *                        by editor/sync.js; the badge/binding always describe
 *                        the currently-open document, since every sync
 *                        operation runs against the open doc — see sync.js).
 *
 * Imperative API (app.js calls these on doc-switch, before any sync:status):
 *   - setBinding(binding|null)   — {owner,repo,branch,path} or null (unbound)
 *   - setSyncState(state)        — one of the five badge states
 *   - setWordCount(n) / setCursor({line,col}) / setLintCount(n)
 *
 * Badge click → opens the sync panel: dispatches the bus event
 * 'sync:open-panel' (app.js owns the panel DOM). The whole binding chip is the
 * click target so an unbound author can reach "Connect to GitHub" from here.
 */

/** @typedef {'local'|'synced'|'local-changes'|'remote-changed'|'conflict'} SyncState */

/** Human labels for the five badge states (FR-GH.6). */
const STATE_LABEL = Object.freeze({
  local: 'Local only',
  synced: 'Synced',
  'local-changes': 'Local changes',
  'remote-changed': 'Remote changed',
  conflict: 'Conflict',
});

const VALID_STATES = new Set(Object.keys(STATE_LABEL));

/**
 * @param {{ mount: HTMLElement, bus?: EventTarget }} opts
 * @returns {{
 *   setBinding: (binding: object|null) => void,
 *   setSyncState: (state: SyncState) => void,
 *   setWordCount: (n: number) => void,
 *   setCursor: (pos: { line: number, col: number }) => void,
 *   setLintCount: (n: number) => void,
 *   getState: () => SyncState,
 *   destroy: () => void,
 * }}
 */
export function createStatusBar({ mount, bus } = {}) {
  if (!mount) throw new Error('createStatusBar: `mount` is required');

  let currentState = /** @type {SyncState} */ ('local');
  let currentBinding = /** @type {object|null} */ (null);

  // ── Build the DOM (replaces the static scaffold placeholder in index.html) ──
  mount.replaceChildren();

  const left = el('div', 'status-group status-left');
  const badge = el('button', 'status-chip');
  badge.type = 'button';
  badge.id = 'status-binding';
  badge.setAttribute('data-state', 'local');
  badge.setAttribute('title', 'Sync status — click to open the GitHub panel');
  const dot = el('span', 'status-dot');
  dot.setAttribute('data-state', 'local');
  const badgeLabel = el('span', 'status-badge-label');
  badgeLabel.textContent = STATE_LABEL.local;
  badge.append(dot, badgeLabel);

  const sep1 = sep();
  const repoEl = el('span', 'status-item');
  repoEl.id = 'status-repo';
  const sep2 = sep();
  const pathEl = el('span', 'status-item');
  pathEl.id = 'status-path';
  pathEl.textContent = 'no repo binding';
  left.append(badge, sep1, repoEl, sep2, pathEl);

  const right = el('div', 'status-group status-right');
  const lintEl = el('span', 'status-item');
  lintEl.id = 'status-lint';
  lintEl.setAttribute('title', 'Lint diagnostics');
  lintEl.textContent = '0 issues';
  const cursorEl = el('span', 'status-item');
  cursorEl.id = 'status-cursor';
  cursorEl.textContent = 'Ln 1, Col 1';
  const wordEl = el('span', 'status-item');
  wordEl.id = 'status-wordcount';
  wordEl.textContent = '0 words';
  right.append(lintEl, sep(), cursorEl, sep(), wordEl);

  mount.append(left, right);

  // ── Imperative setters ────────────────────────────────────────────────────
  function setSyncState(state) {
    const next = VALID_STATES.has(state) ? state : 'local';
    currentState = next;
    dot.setAttribute('data-state', next);
    badge.setAttribute('data-state', next);
    badgeLabel.textContent = STATE_LABEL[next];
  }

  /**
   * @param {{owner?:string, repo?:string, branch?:string, path?:string}|null} binding
   * A full binding (owner+repo) shows "owner/repo · branch · path" and keeps
   * the current badge; a path-only object (unbound doc) shows just the intended
   * path and forces the "Local only" badge; null shows "no repo binding".
   */
  function setBinding(binding) {
    const bound = !!(binding && binding.owner && binding.repo);
    currentBinding = bound ? binding : null;
    if (bound) {
      const { owner, repo, branch, path } = binding;
      repoEl.textContent = `${owner}/${repo}${branch ? ` · ${branch}` : ''}`;
      repoEl.hidden = false;
      sep1.hidden = false;
      pathEl.textContent = path || 'no repo path';
      sep2.hidden = false;
      pathEl.hidden = false;
    } else {
      repoEl.textContent = '';
      repoEl.hidden = true;
      sep1.hidden = true;
      const path = binding && binding.path;
      pathEl.textContent = path || 'no repo binding';
      sep2.hidden = true;
      pathEl.hidden = false;
      // An unbound doc is always "Local only".
      if (currentState !== 'local') setSyncState('local');
    }
  }

  function setWordCount(n) {
    wordEl.textContent = `${Number(n || 0).toLocaleString()} words`;
  }

  function setCursor(pos) {
    if (!pos) return;
    cursorEl.textContent = `Ln ${pos.line}, Col ${pos.col}`;
  }

  function setLintCount(n) {
    const count = Number(n || 0);
    lintEl.textContent = `${count} issue${count === 1 ? '' : 's'}`;
  }

  // ── Bus wiring (owned here now, not in app.js) ────────────────────────────
  const onWordCount = (e) => { if (e.detail) setWordCount(e.detail.words); };
  const onCursor = (e) => { if (e.detail) setCursor(e.detail); };
  const onLint = (e) => { if (e.detail) setLintCount(e.detail.count); };
  const onSyncStatus = (e) => {
    const d = e.detail || {};
    if ('binding' in d) setBinding(d.binding);
    if (d.state) setSyncState(d.state);
  };

  if (bus && typeof bus.addEventListener === 'function') {
    bus.addEventListener('editor:wordcount', onWordCount);
    bus.addEventListener('editor:cursor', onCursor);
    bus.addEventListener('lint:count', onLint);
    bus.addEventListener('sync:status', onSyncStatus);
  }

  // Badge click → open the sync panel (app.js listens on the bus).
  const onBadgeClick = () => {
    if (bus && typeof bus.dispatchEvent === 'function') {
      bus.dispatchEvent(new CustomEvent('sync:open-panel', { detail: {} }));
    }
  };
  badge.addEventListener('click', onBadgeClick);

  // Initial render.
  setBinding(null);

  return {
    setBinding,
    setSyncState,
    setWordCount,
    setCursor,
    setLintCount,
    getState: () => currentState,
    destroy() {
      badge.removeEventListener('click', onBadgeClick);
      if (bus && typeof bus.removeEventListener === 'function') {
        bus.removeEventListener('editor:wordcount', onWordCount);
        bus.removeEventListener('editor:cursor', onCursor);
        bus.removeEventListener('lint:count', onLint);
        bus.removeEventListener('sync:status', onSyncStatus);
      }
      mount.replaceChildren();
    },
  };
}

// ── tiny DOM helpers ──────────────────────────────────────────────────────
function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function sep() {
  const s = el('span', 'status-sep');
  s.setAttribute('aria-hidden', 'true');
  s.textContent = '·';
  return s;
}
