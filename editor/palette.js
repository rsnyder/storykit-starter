/**
 * editor/palette.js — command palette (WP-6.1)
 *
 * Spec: docs/editor-spec.md §5.4 ("Full keyboard operability: every command
 * reachable via keyboard; a ⌘K command palette exposes all actions with
 * their shortcuts"). docs/editor-plan.md §3 WP-6.1.
 *
 *   createPalette({ mount, commands })
 *     → { open(), close(), isOpen(), destroy() }
 *
 *   mount    — HTMLElement the palette's backdrop+dialog DOM is appended to
 *              (app.js passes document.body). Nothing else in `mount` is
 *              touched.
 *   commands — a REGISTRY ARRAY (not a function): each entry is
 *              `{ id, label, group, shortcut?, when?: () => boolean, run: () => void }`.
 *              `when()` is re-evaluated every time the palette opens (so
 *              gating reflects live app state — e.g. "Commit" only once a
 *              document is bound); an entry whose `when()` returns false is
 *              OMITTED from the list entirely for that open() (hidden, not
 *              merely disabled — simplest correct reading of "Disabled/
 *              hidden entries via when" for a filterable list where a
 *              greyed-out-but-unreachable-by-typing entry would be
 *              confusing). `run()` is called synchronously on Enter/click;
 *              the palette closes immediately afterward regardless of what
 *              `run()` does.
 *
 * ── ⌘K wiring (owned by app.js, NOT this module) ────────────────────────
 * This module does not itself listen for ⌘K — see docs/editor-plan.md
 * WP-6.1's remap note (also in editor/commands.js's header): the palette's
 * ⌘K trigger is a WINDOW-level, capture-phase keydown listener installed by
 * app.js's wireControls() (mirroring the existing ⌘E mode-cycle listener),
 * so it fires before CM6's own keymap ever sees the keystroke and works
 * even when focus is outside the editor (sidebar, toolbar, body). This
 * module only exposes `open()`/`close()`/`isOpen()` for that wiring (and for
 * the toolbar/other affordances) to call.
 *
 * ── UI pattern ───────────────────────────────────────────────────────────
 * Combobox pattern, modeled on editor/wikidata.js's search popup (input +
 * filtered listbox, ArrowUp/Down + Enter, Esc closes/returns focus) but
 * centered with a backdrop and a MANUAL, document-capture-phase focus trap
 * — the same robust technique editor/conflict.js uses (proven to survive
 * synthetic/programmatic Tab events, which the wikidata popup's "hand off
 * to the browser's native tab order" approach does not; see conflict.js's
 * header note). Filtering is substring-first, falling back to an in-order
 * character-subsequence ("fuzzy-ish") match so e.g. "ins vwr" still surfaces
 * "Insert viewer" entries even though it isn't a literal substring.
 *
 * Selectors for tests/e2e:
 *   `.sk-palette-backdrop`         the overlay (present only while open)
 *   `.sk-palette`                  the dialog root (role="dialog")
 *   `.sk-palette-input`            the filter input (role="combobox")
 *   `.sk-palette-list`             the listbox
 *   `.sk-palette-item`             one command row (role="option")
 *   `[data-sk-palette-id="<id>"]`  a specific command row, by registry id
 */

// ── injected styles (own stylesheet, --sk-* tokens with hermetic fallbacks —
//    mirrors editor/wikidata.js's / editor/conflict.js's ensureStyles) ──────
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'sk-palette-styles';
  style.textContent = `
.sk-palette-backdrop {
  position: fixed; inset: 0; z-index: 10060;
  background: var(--sk-backdrop, rgba(15, 18, 22, .45));
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: min(14vh, 140px);
}
.sk-palette {
  width: min(560px, calc(100vw - 32px));
  max-height: min(60vh, 520px);
  display: flex; flex-direction: column; min-height: 0;
  background: var(--sk-elevated, #fff); color: var(--sk-text, #1f2328);
  border: 1px solid var(--sk-border, #d8dee4); border-radius: var(--sk-radius-lg, 10px);
  box-shadow: var(--sk-shadow-2, 0 8px 24px rgba(31, 35, 40, .18));
  font: var(--sk-fs-base, 14px)/1.4 var(--sk-font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
  overflow: hidden;
}
.sk-palette:focus { outline: none; }
.sk-palette-input-row { display: flex; align-items: center; border-bottom: 1px solid var(--sk-border, #d8dee4); padding: 10px var(--sk-space-2, 16px); }
.sk-palette-input {
  flex: 1 1 auto; border: none; outline: none; background: transparent; color: var(--sk-text, #1f2328);
  font: inherit; font-size: var(--sk-fs-md, 15px); padding: 6px 0;
}
.sk-palette-hint { flex: 0 0 auto; color: var(--sk-text-faint, #6e7781); font-size: var(--sk-fs-xs, 12px); }
.sk-palette-list { list-style: none; margin: 0; padding: 6px; overflow-y: auto; flex: 1 1 auto; }
.sk-palette-group-label {
  padding: 6px 8px 2px; font-size: var(--sk-fs-xs, 12px); font-weight: 700; letter-spacing: .04em;
  text-transform: uppercase; color: var(--sk-text-faint, #6e7781);
}
.sk-palette-item {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sk-space-2, 16px);
  padding: 8px 10px; border-radius: var(--sk-radius, 6px); cursor: pointer;
}
.sk-palette-item.is-active, .sk-palette-item:hover { background: var(--sk-selection, rgba(9,105,218,.14)); }
.sk-palette-item-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sk-text, #1f2328); }
.sk-palette-item-shortcut {
  flex: 0 0 auto; font-family: var(--sk-font-mono, ui-monospace, monospace); font-size: var(--sk-fs-xs, 12px);
  color: var(--sk-text-muted, #57606a); background: var(--sk-bg-sunken, #f6f8fa);
  border: 1px solid var(--sk-border, #d8dee4); border-radius: var(--sk-radius-sm, 4px); padding: 1px 6px;
}
.sk-palette-empty { padding: var(--sk-space-3, 24px); text-align: center; color: var(--sk-text-faint, #6e7781); font-size: var(--sk-fs-sm, 13px); }
`;
  document.head.appendChild(style);
}

// ── fuzzy-ish substring/subsequence filter ──────────────────────────────

/** @param {string} query @param {string} label @returns {boolean} */
export function matchesQuery(query, label) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const l = (label || '').toLowerCase();
  if (l.includes(q)) return true;
  // In-order character subsequence match ("fuzzy-ish").
  let qi = 0;
  for (let li = 0; li < l.length && qi < q.length; li++) {
    if (l[li] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ── focus trap helpers (mirrors editor/conflict.js's getFocusableEls) ────

function getFocusableEls(root) {
  const selector = 'button:not([disabled]), [href], input:not([disabled]), '
    + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(selector)).filter((el) => !el.hidden && !el.closest('[hidden]'));
}

/**
 * @param {{ mount: HTMLElement, commands: Array<{id:string, label:string, group:string, shortcut?:string, when?:()=>boolean, run:()=>void}> }} opts
 * @returns {{ open: () => void, close: () => void, isOpen: () => boolean, destroy: () => void }}
 */
export function createPalette({ mount, commands } = {}) {
  if (!mount) throw new Error('createPalette: `mount` is required');
  const registry = Array.isArray(commands) ? commands : [];
  ensureStyles();

  let backdrop = null;
  let dialog = null;
  let input = null;
  let list = null;
  let visible = [];
  let activeIndex = -1;
  let previouslyFocused = null;
  let open_ = false;

  function visibleEntries() {
    return registry.filter((c) => (typeof c.when === 'function' ? !!c.when() : true));
  }

  function filtered(query) {
    return visible.filter((c) => matchesQuery(query, c.label) || matchesQuery(query, c.group || ''));
  }

  function renderList(query) {
    list.replaceChildren();
    const items = filtered(query);
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'sk-palette-empty';
      empty.textContent = 'No matching commands.';
      list.appendChild(empty);
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return items;
    }
    if (activeIndex >= items.length) activeIndex = 0;
    if (activeIndex < 0) activeIndex = 0;

    let lastGroup = null;
    items.forEach((cmd, i) => {
      if (cmd.group && cmd.group !== lastGroup) {
        lastGroup = cmd.group;
        const groupLi = document.createElement('li');
        groupLi.className = 'sk-palette-group-label';
        groupLi.textContent = cmd.group;
        groupLi.setAttribute('role', 'presentation');
        list.appendChild(groupLi);
      }
      const li = document.createElement('li');
      li.className = 'sk-palette-item' + (i === activeIndex ? ' is-active' : '');
      li.id = `sk-palette-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === activeIndex));
      li.dataset.skPaletteId = cmd.id;
      li.dataset.index = String(i);

      const label = document.createElement('span');
      label.className = 'sk-palette-item-label';
      label.textContent = cmd.label;
      li.appendChild(label);

      if (cmd.shortcut) {
        const kbd = document.createElement('span');
        kbd.className = 'sk-palette-item-shortcut';
        kbd.textContent = cmd.shortcut;
        li.appendChild(kbd);
      }

      li.addEventListener('click', () => runEntry(cmd));
      list.appendChild(li);
    });
    if (activeIndex >= 0) input.setAttribute('aria-activedescendant', `sk-palette-opt-${activeIndex}`);
    return items;
  }

  function moveActive(delta, query) {
    const items = filtered(query);
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    renderList(query);
  }

  function runEntry(cmd) {
    if (!cmd) return;
    close();
    try {
      cmd.run();
    } catch (err) {
      console.error('[storykit-editor] palette command failed', cmd.id, err);
    }
  }

  function build() {
    backdrop = document.createElement('div');
    backdrop.className = 'sk-palette-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });

    dialog = document.createElement('div');
    dialog.className = 'sk-palette';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Command palette');
    dialog.tabIndex = -1;

    const inputRow = document.createElement('div');
    inputRow.className = 'sk-palette-input-row';

    input = document.createElement('input');
    input.type = 'text';
    input.className = 'sk-palette-input';
    input.placeholder = 'Type a command…';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'sk-palette-listbox');

    const hint = document.createElement('span');
    hint.className = 'sk-palette-hint';
    hint.textContent = 'Esc to close';

    inputRow.append(input, hint);

    list = document.createElement('ul');
    list.className = 'sk-palette-list';
    list.id = 'sk-palette-listbox';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Commands');

    dialog.append(inputRow, list);
    backdrop.appendChild(dialog);

    input.addEventListener('input', () => {
      activeIndex = 0;
      renderList(input.value);
    });
    input.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveActive(1, input.value);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(-1, input.value);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const items = filtered(input.value);
      const cmd = activeIndex >= 0 ? items[activeIndex] : null;
      if (cmd) runEntry(cmd);
      return;
    }
    // Escape is handled by the document-level capture listener below (so it
    // works no matter which focusable element inside the trap has focus —
    // same rationale as editor/conflict.js's onKeydown).
  }

  function onDocumentKeydown(e) {
    if (!open_) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = getFocusableEls(dialog);
    if (!focusables.length) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const currentIdx = focusables.indexOf(document.activeElement);
    let nextIdx;
    if (currentIdx === -1) {
      nextIdx = e.shiftKey ? focusables.length - 1 : 0;
    } else {
      nextIdx = e.shiftKey
        ? (currentIdx - 1 + focusables.length) % focusables.length
        : (currentIdx + 1) % focusables.length;
    }
    focusables[nextIdx].focus();
  }

  function open() {
    if (open_) {
      input?.focus();
      return;
    }
    if (!backdrop) build();
    previouslyFocused = document.activeElement;
    visible = visibleEntries();
    activeIndex = 0;
    input.value = '';
    renderList('');
    mount.appendChild(backdrop);
    document.addEventListener('keydown', onDocumentKeydown, true);
    open_ = true;
    input.focus();
  }

  function close() {
    if (!open_) return;
    open_ = false;
    document.removeEventListener('keydown', onDocumentKeydown, true);
    if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      previouslyFocused.focus();
    }
    previouslyFocused = null;
  }

  function isOpen() {
    return open_;
  }

  function destroy() {
    close();
    backdrop = null;
    dialog = null;
    input = null;
    list = null;
  }

  return { open, close, isOpen, destroy };
}
