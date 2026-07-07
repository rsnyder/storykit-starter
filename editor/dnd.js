/**
 * editor/dnd.js — drop/paste tag-insertion handlers (WP-4.1)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2.
 *
 *   dndExtension({ onNotice })  →  Extension[]
 *
 * Layers CM6 drop/paste handling over the pure grammar in
 * editor/url-grammars.js (`parseDropPayload`, FR-DND.2–4/6). This module
 * owns only *placement*, *feedback*, and *affordance* UX (FR-DND.1/5/6/7,
 * spec §7 "Drop feedback") — it never re-implements URL classification.
 *
 * `onNotice` contract (consumed by WP-4.3, which routes it to the app's
 * `toast` bus event — see editor/app.js's existing `{ message, level }`
 * shape used by doclist.js/app.js today): called with
 *   { message: string, level: 'warning' }
 * for every degrade/fallback path that would otherwise be a silent no-op:
 * maps-short links, unrecognized-but-URL-shaped drops/pastes, and local
 * image files (no v1 upload flow yet).
 *
 * ── dragover protected-mode caveat (risk R-7 / spec §7) ────────────────
 * Most browsers only expose `dataTransfer.types` during `dragover` —
 * `getData()` reliably returns '' until `drop` fires (drag-and-drop's
 * "protected mode"). So the drag-over chip is deliberately generic
 * ("Drop to insert") rather than a precise `chipLabel` preview; the exact
 * classification (and the precise §7 chip copy, e.g. "Image viewer ·
 * wc:…") only happens once `drop` fires and `getData()` is finally
 * readable. This is documented behaviour, not a bug — see the WP-4.1
 * handoff notes for the alternatives considered.
 *
 * The blinking insertion-point *caret* during drag (as opposed to the
 * chip) is intentionally NOT duplicated here: editor.js's base extension
 * set already includes CM6's own `dropCursor()` unconditionally, and this
 * module is always spliced into `extraExtensions` alongside it (the
 * frozen `createEditor` contract), so a second instance would just be a
 * redundant/duplicate-looking cursor. Consumers that mount this
 * extension array without editor.js's base set (e.g. this file's own
 * unit tests) won't get a native drop caret, only the chip.
 */

import { EditorView, WidgetType, Decoration, ViewPlugin, keymap } from '@codemirror/view';
import { StateField, StateEffect, EditorSelection, Prec } from '@codemirror/state';

import { parseDropPayload } from './url-grammars.js';

/* ============================================================================
 * Shared helpers
 * ========================================================================== */

const BLOCK_TAG_KINDS = new Set(['commons', 'youtube', 'maps']);

const LOCAL_IMAGE_NOTICE =
  'Local image files can’t be inserted by drag-and-drop yet. Upload the ' +
  'file to your repo’s assets/posts/ folder and reference it with a ' +
  'plain markdown-it image or a viewer tag’s src attribute — see the ' +
  'image-viewer guide’s "local image" workflow.';

const UNKNOWN_URL_NOTICE =
  'Couldn’t recognize that link, so nothing was inserted. Commons, ' +
  'YouTube, Google Maps, and plain http(s) links are supported.';

function hasDroppedFiles(dataTransfer) {
  return !!(dataTransfer && dataTransfer.files && dataTransfer.files.length > 0);
}

/**
 * Mirrors url-grammars.js's internal `pickCandidate` (not exported — this
 * module only needs it to answer "does this unclassified drop/paste at
 * least *look* like a URL?", a UX judgment call that belongs here, not in
 * the frozen grammar table).
 */
function pickCandidate(uriList, text) {
  if (uriList) {
    const lines = String(uriList).split(/\r\n|\r|\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) return trimmed;
    }
  }
  if (text) {
    const trimmed = String(text).trim();
    if (trimmed) return trimmed;
  }
  return null;
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function looksLikeUrl(candidate) {
  if (!candidate) return false;
  const s = candidate.trim();
  if (!s || /\s/.test(s)) return false;
  return URL_SCHEME_RE.test(s) || /^www\./i.test(s);
}

function readFlavors(dataTransfer) {
  return {
    uriList: dataTransfer.getData('text/uri-list'),
    text: dataTransfer.getData('text/plain'),
    html: dataTransfer.getData('text/html'),
  };
}

/* ============================================================================
 * FR-DND.1 — block-tag placement ("own line, surrounded by blank lines,
 * collapse duplicates if surrounding blanks already exist")
 *
 * Strategy: anchor on the line containing the drop position — if that line
 * is blank, the tag goes right there; otherwise the tag goes right after
 * the whole line (never splitting a paragraph mid-sentence). Then expand
 * outward from that anchor over any *existing* run of blank lines (bounded
 * scan — real documents never have hundreds of consecutive blank lines) so
 * whatever blank-line run is already there gets collapsed to exactly one
 * on each side, instead of stacking a fresh pair on top of it. At the very
 * start/end of the document the corresponding blank line is omitted
 * entirely (nothing to separate the tag from).
 * ========================================================================== */

const BLANK_SCAN_WINDOW = 200;

function computeBlockInsertion(doc, pos, tag) {
  const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
  const anchor = line.length === 0 ? line.from : line.to;

  const left = doc.sliceString(Math.max(0, anchor - BLANK_SCAN_WINDOW), anchor);
  const right = doc.sliceString(anchor, Math.min(doc.length, anchor + BLANK_SCAN_WINDOW));
  const leftBlankRun = /\n*$/.exec(left)[0];
  const rightBlankRun = /^\n*/.exec(right)[0];

  const from = anchor - leftBlankRun.length;
  const to = anchor + rightBlankRun.length;
  const atDocStart = from === 0;
  const atDocEnd = to === doc.length;

  const before = atDocStart ? '' : '\n\n';
  const after = atDocEnd ? '' : '\n\n';
  const insert = before + tag + after;
  const tagFrom = from + before.length;
  const tagTo = tagFrom + tag.length;

  return { from, to, insert, tagFrom, tagTo };
}

/* ============================================================================
 * FR-DND.5 — post-insert affordance ("Add caption · Add id")
 * ========================================================================== */

const setHint = StateEffect.define(); // value: { from, to } | null

/**
 * Inserts ` <attrName>=""` just before the tag's closing `%}`, placing the
 * cursor between the two quotes. No-ops (beyond dismissing the hint) if
 * the attribute already appears in the tag, or if `range` no longer looks
 * like a `{% ... %}` tag (defensive — shouldn't happen since the hint only
 * ever targets a tag this module itself just inserted).
 */
function insertTagAttr(view, range, attrName) {
  const text = view.state.sliceDoc(range.from, range.to);
  const alreadyPresent = new RegExp(`[\\s{]${attrName}\\s*=`).test(text);
  const closeIdx = text.lastIndexOf('%}');

  if (alreadyPresent || closeIdx === -1) {
    view.dispatch({ effects: setHint.of(null) });
    return;
  }

  let insertOffset = closeIdx;
  while (insertOffset > 0 && text[insertOffset - 1] === ' ') insertOffset--;

  const insertion = ` ${attrName}=""`;
  const pos = range.from + insertOffset;
  const cursorPos = pos + insertion.length - 1; // between the two quotes

  view.dispatch({
    changes: { from: pos, to: pos, insert: insertion },
    selection: EditorSelection.cursor(cursorPos),
    effects: setHint.of(null),
    scrollIntoView: true,
    userEvent: 'input.complete',
  });
  view.focus();
}

/**
 * ── WP-6.1 keyboard-reachability fix (spec §5.4 / FR-DND.7) ───────────────
 *
 * PROBLEM FOUND: these widgets' buttons are real, focusable `<button>`
 * elements, but they live inside CM6's `contentDOM` (a `contenteditable`
 * region) alongside the base editor keymap's OWN `Tab` binding
 * (`indentWithTab`, from editor/commands.js's `editorKeymap`) and `Enter`
 * binding (`insertNewlineContinueMarkup`). CM6 attaches its keymap's keydown
 * listener to `contentDOM` itself; a keydown fired at a descendant button
 * bubbles up to that listener same as any other DOM event, so — verified
 * empirically (see tests/unit/dnd.test.js / tests/e2e/test_m6_keyboard.py)
 * — pressing Tab or Enter while one of these buttons has focus was
 * reinterpreted as "indent" / "insert newline in the document" instead of
 * the button's own default (focus-move / activate) behaviour. Worse: since
 * CM6 also intercepts bare `Tab` for indent, there was never a way to Tab
 * FROM the editor content INTO these buttons in the first place — the
 * keystroke never reached the browser's native tab-order logic.
 *
 * FIX: `insulateFromEditorKeymap(btn, { onEscape })` stops EVERY keydown on
 * the button from propagating up to CM6's contentDOM listener
 * (`stopPropagation`, never `preventDefault` for ordinary keys) — so the
 * *browser's own* default handling still runs unimpeded (Tab moves focus
 * to/from the button in native tab order; Enter/Space activates it), while
 * CM6 never gets a chance to reinterpret the key as an editor command.
 * `onEscape` is wired to each widget's existing dismiss semantics.
 *
 * The paste-affordance button (FR-DND.7's explicit "keyboard equivalent for
 * non-pointer users") additionally AUTOFOCUSES ITSELF the moment it appears
 * — this is what makes it reachable at all without Tab ever working from
 * inside the (Tab-trapping) editor content; see `PasteAffordanceWidget`
 * below. The post-insert hint's "Add caption"/"Add id" buttons (FR-DND.5)
 * get the same propagation fix for when a keyboard user reaches them by
 * other means (a future affordance, or simply clicking then Tabbing) but do
 * NOT autofocus — both the drop path and the paste-accept path already call
 * `view.focus()` right after showing the hint, and stealing that focus back
 * to a button would fight that existing, intentional behaviour.
 */
function insulateFromEditorKeymap(btn, { onEscape } = {}) {
  btn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && typeof onEscape === 'function') {
      e.preventDefault();
      onEscape();
    }
  });
}

class TagHintWidget extends WidgetType {
  constructor(from, to) {
    super();
    this.from = from;
    this.to = to;
  }

  eq(other) {
    return other.from === this.from && other.to === this.to;
  }

  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'sk-dnd-hint';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Inserted tag — quick edits');

    const label = document.createElement('span');
    label.className = 'sk-dnd-hint-label';
    label.textContent = 'Tag inserted';
    wrap.appendChild(label);

    const mkBtn = (text, attrName) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sk-dnd-hint-btn';
      btn.textContent = text;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        insertTagAttr(view, { from: this.from, to: this.to }, attrName);
      });
      insulateFromEditorKeymap(btn, {
        onEscape: () => {
          view.dispatch({ effects: setHint.of(null) });
          view.focus();
        },
      });
      return btn;
    };

    const sep = document.createElement('span');
    sep.className = 'sk-dnd-hint-sep';
    sep.setAttribute('aria-hidden', 'true');
    sep.textContent = '·';

    wrap.appendChild(mkBtn('Add caption', 'caption'));
    wrap.appendChild(sep.cloneNode(true));
    wrap.appendChild(mkBtn('Add id', 'id'));
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

const hintField = StateField.define({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setHint)) return e.value;
    }
    // Any other edit, or any selection change not carried by our own
    // setHint-bearing transaction, dismisses the hint (FR-DND.5: "dismiss
    // on any other edit/click/Esc" — Esc is handled by hintEscKeymap
    // below, which also dispatches setHint.of(null)).
    if (value && (tr.docChanged || tr.selection)) return null;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (value) => {
      if (!value) return Decoration.none;
      return Decoration.set([
        Decoration.widget({ widget: new TagHintWidget(value.from, value.to), side: 1, block: true }).range(
          value.to
        ),
      ]);
    }),
});

/* ============================================================================
 * FR-DND.7 — paste affordance ("Paste as StoryKit tag?")
 * ========================================================================== */

const setPaste = StateEffect.define(); // value: { from, to, tag, chipLabel, kind } | null
const clearPaste = StateEffect.define();

const PASTE_EXPIRY_MS = 8000;

const pasteField = StateField.define({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setPaste)) return e.value;
      if (e.is(clearPaste)) return null;
    }
    if (!value) return value;
    if (tr.docChanged) {
      // Position tracking via mapping: edits *inside* the pasted range
      // (e.g. the user tweaking what they just pasted) keep the
      // affordance alive at its remapped position. Any edit that touches
      // outside the range ("elsewhere") expires it immediately, ahead of
      // the 8s timer.
      let touchedElsewhere = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (toA <= value.from || fromA >= value.to) touchedElsewhere = true;
      });
      if (touchedElsewhere) return null;
      const from = tr.changes.mapPos(value.from, 1);
      const to = tr.changes.mapPos(value.to, -1);
      if (from >= to) return null;
      return { ...value, from, to };
    }
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (value) => {
      if (!value) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new PasteAffordanceWidget(value.from, value.to, value.tag, value.chipLabel, value.kind),
          side: 1,
        }).range(value.to),
      ]);
    }),
});

class PasteAffordanceWidget extends WidgetType {
  constructor(from, to, tag, chipLabel, kind) {
    super();
    this.from = from;
    this.to = to;
    this.tag = tag;
    this.chipLabel = chipLabel;
    this.kind = kind;
  }

  eq(other) {
    return other.from === this.from && other.to === this.to && other.tag === this.tag;
  }

  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'sk-dnd-paste-affordance';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sk-dnd-paste-btn';
    btn.textContent = 'Paste as StoryKit tag?';
    if (this.chipLabel) btn.title = this.chipLabel;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = view.state.field(pasteField, false);
      if (!cur) return;
      const tagFrom = cur.from;
      const tagTo = tagFrom + cur.tag.length;
      const effects = [clearPaste.of(null)];
      if (BLOCK_TAG_KINDS.has(cur.kind)) effects.push(setHint.of({ from: tagFrom, to: tagTo }));
      view.dispatch({
        changes: { from: cur.from, to: cur.to, insert: cur.tag },
        selection: EditorSelection.range(tagFrom, tagTo),
        effects,
        scrollIntoView: true,
        userEvent: 'input.complete',
      });
      view.focus();
    });
    insulateFromEditorKeymap(btn, {
      onEscape: () => {
        view.dispatch({ effects: clearPaste.of(null) });
        view.focus();
      },
    });

    wrap.appendChild(btn);

    // Autofocus: the ONLY way this button is keyboard-reachable at all — see
    // the "WP-6.1 keyboard-reachability fix" note above `TagHintWidget`.
    // Real pastes always happen while the editor has keyboard focus, so this
    // never steals focus from somewhere the author actively put it; CM6
    // reuses this same widget DOM (via `eq()`) across re-renders that don't
    // change from/to/tag, so this only fires once per distinct affordance.
    queueMicrotask(() => {
      if (btn.isConnected) btn.focus({ preventScroll: true });
    });

    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * Per-view timer that clears the paste affordance ~8s after it last
 * changed (a fresh paste, or a remap from an in-range edit, both reset
 * the clock — see pasteField.update above).
 */
const pasteExpiryPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.timer = null;
      this.current = view.state.field(pasteField, false) ?? null;
      this.arm(this.current);
    }

    update(update) {
      const next = update.state.field(pasteField, false) ?? null;
      if (next !== this.current) {
        this.current = next;
        this.arm(next);
      }
    }

    arm(value) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (!value) return;
      const captured = value;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.view.state.field(pasteField, false) === captured) {
          this.view.dispatch({ effects: clearPaste.of(null) });
        }
      }, PASTE_EXPIRY_MS);
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  }
);

/* ============================================================================
 * Esc dismisses whichever affordance is showing (FR-DND.5)
 * ========================================================================== */

const dismissOnEscape = Prec.high(
  keymap.of([
    {
      key: 'Escape',
      run(view) {
        const h = view.state.field(hintField, false);
        const p = view.state.field(pasteField, false);
        if (!h && !p) return false;
        const effects = [];
        if (h) effects.push(setHint.of(null));
        if (p) effects.push(clearPaste.of(null));
        view.dispatch({ effects });
        return true;
      },
    },
  ])
);

/* ============================================================================
 * §7 drag-over chip + insertion caret
 * ========================================================================== */

class DragChip {
  constructor() {
    this.dom = null;
  }

  show(x, y, label) {
    if (!this.dom) {
      this.dom = document.createElement('div');
      this.dom.className = 'sk-dnd-chip';
      document.body.appendChild(this.dom);
    }
    this.dom.textContent = label;
    this.dom.style.left = `${x + 14}px`;
    this.dom.style.top = `${y + 18}px`;
    this.dom.style.display = 'block';
  }

  hide() {
    if (this.dom) this.dom.style.display = 'none';
  }

  destroy() {
    if (this.dom && this.dom.parentNode) this.dom.parentNode.removeChild(this.dom);
    this.dom = null;
  }
}

const dragChipPlugin = ViewPlugin.define(() => new DragChip());

/* ============================================================================
 * Drop / paste event handlers
 * ========================================================================== */

/**
 * `posAtCoords` does character-level hit-testing and can return null at the
 * edges of the document — most notably a completely empty first line (a
 * zero-width box with nothing to hit-test against; verified empirically,
 * see tests/unit/dnd.test.js). Fall back to the nearest line by vertical
 * position (`lineBlockAtHeight`, document-relative via `view.documentTop`)
 * rather than defaulting to end-of-document, so a drop onto/near a blank
 * line still lands where the user aimed instead of jumping to the bottom.
 */
function resolveDropPos(view, event) {
  const precise = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (precise != null) return precise;
  const relY = Math.max(0, event.clientY - view.documentTop);
  const block = view.lineBlockAtHeight(relY);
  return block ? block.from : view.state.doc.length;
}

function insertBlockTag(view, pos, tag) {
  const plan = computeBlockInsertion(view.state.doc, pos, tag);
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: EditorSelection.range(plan.tagFrom, plan.tagTo),
    effects: setHint.of({ from: plan.tagFrom, to: plan.tagTo }),
    scrollIntoView: true,
    userEvent: 'input.drop',
  });
  view.focus();
}

function insertInline(view, pos, text) {
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: EditorSelection.cursor(pos + text.length),
    scrollIntoView: true,
    userEvent: 'input.drop',
  });
  view.focus();
}

function makeDomEventHandlers(onNotice) {
  const notify = (message) => {
    if (typeof onNotice === 'function') onNotice({ message, level: 'warning' });
  };

  return EditorView.domEventHandlers({
    dragover(event, view) {
      const chip = view.plugin(dragChipPlugin);
      const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
      const interesting =
        types.includes('text/uri-list') || types.includes('text/html') ||
        types.includes('text/plain') || types.includes('Files');
      if (interesting) {
        if (chip) chip.show(event.clientX, event.clientY, 'Drop to insert');
        // Protected-mode caveat (see module header): types are all we can
        // read here, so this chip is deliberately generic — the precise
        // chipLabel only becomes available once `drop` fires.
        event.preventDefault();
      } else if (chip) {
        chip.hide();
      }
      return false; // let dropCursor's own dragover handling still run
    },

    dragleave(event, view) {
      if (view.dom.contains(event.relatedTarget)) return false;
      const chip = view.plugin(dragChipPlugin);
      if (chip) chip.hide();
      return false;
    },

    drop(event, view) {
      const chip = view.plugin(dragChipPlugin);
      if (chip) chip.hide();

      const dataTransfer = event.dataTransfer;
      if (!dataTransfer) return false;

      if (hasDroppedFiles(dataTransfer)) {
        event.preventDefault();
        notify(LOCAL_IMAGE_NOTICE);
        return true;
      }

      const { uriList, text, html } = readFlavors(dataTransfer);
      const result = parseDropPayload({ uriList, text, html });

      const pos = resolveDropPos(view, event);

      if (result.tag) {
        event.preventDefault();
        if (result.kind === 'link') {
          insertInline(view, pos, result.tag);
        } else {
          insertBlockTag(view, pos, result.tag);
        }
        return true;
      }

      if (result.kind === 'maps-short') {
        event.preventDefault();
        notify(result.message);
        return true;
      }

      // kind === 'unknown': only intercept (and notify) when the payload
      // was clearly meant as a link — plain prose drags fall through to
      // CM6's normal text-drop handling untouched.
      const candidate = pickCandidate(uriList, text);
      if (looksLikeUrl(candidate)) {
        event.preventDefault();
        notify(UNKNOWN_URL_NOTICE);
        return true;
      }

      return false;
    },

    paste(event, view) {
      const dataTransfer = event.clipboardData;
      if (!dataTransfer) return false;

      if (hasDroppedFiles(dataTransfer)) {
        event.preventDefault();
        notify(LOCAL_IMAGE_NOTICE);
        return true;
      }

      const { uriList, text, html } = readFlavors(dataTransfer);
      const result = parseDropPayload({ uriList, text, html });

      if (!result.tag) {
        // FR-DND.7 only offers the affordance for payloads that *can*
        // become a tag; maps-short still gets the same degrade notice as
        // the drop path, but (per FR-DND.7) the raw pasted text is always
        // left to insert normally rather than being blocked.
        if (result.kind === 'maps-short') notify(result.message);
        return false;
      }

      // Never transform automatically (FR-DND.7): insert the raw
      // text/plain flavor ourselves (matches what a plain-text CM6 paste
      // would do), then offer the affordance over the just-pasted range.
      event.preventDefault();
      const raw = text != null ? text : '';
      const sel = view.state.selection.main;
      const from = sel.from;
      const to = from + raw.length;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: raw },
        selection: EditorSelection.cursor(to),
        effects: setPaste.of({ from, to, tag: result.tag, chipLabel: result.chipLabel, kind: result.kind }),
        userEvent: 'input.paste',
      });
      view.focus();
      return true;
    },
  });
}

/* ============================================================================
 * Styles (EditorView.baseTheme — reuses the --sk-* tokens already defined
 * on :root by editor/styles.css; no shared-file edits needed).
 * ========================================================================== */

const dndTheme = EditorView.baseTheme({
  '.sk-dnd-chip': {
    position: 'fixed',
    zIndex: '2000',
    pointerEvents: 'none',
    font: '500 12px/1.4 var(--sk-font-sans, sans-serif)',
    color: 'var(--sk-accent-contrast, #fff)',
    background: 'var(--sk-text, #1f2328)',
    border: '1px solid var(--sk-border-strong, #444)',
    borderRadius: 'var(--sk-radius, 6px)',
    padding: '4px 10px',
    boxShadow: 'var(--sk-shadow-2, 0 8px 24px rgba(0,0,0,.25))',
    display: 'none',
  },
  '.sk-dnd-hint': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    font: '500 12px/1.4 var(--sk-font-sans, sans-serif)',
    color: 'var(--sk-text-muted, #57606a)',
    background: 'var(--sk-bg-sunken, #f6f8fa)',
    border: '1px solid var(--sk-border, #d8dee4)',
    borderRadius: 'var(--sk-radius, 6px)',
    padding: '3px 8px',
    margin: '2px 0 4px',
    width: 'fit-content',
  },
  '.sk-dnd-hint-label': { color: 'var(--sk-text-faint, #6e7781)' },
  '.sk-dnd-hint-sep': { color: 'var(--sk-text-faint, #6e7781)' },
  '.sk-dnd-hint-btn': {
    appearance: 'none',
    border: 'none',
    background: 'none',
    color: 'var(--sk-accent, #0056b2)',
    font: 'inherit',
    fontWeight: '600',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: 'var(--sk-radius-sm, 4px)',
  },
  '.sk-dnd-hint-btn:hover': { background: 'var(--sk-selection, rgba(9,105,218,.14))' },
  '.sk-dnd-paste-affordance': { marginLeft: '4px' },
  '.sk-dnd-paste-btn': {
    appearance: 'none',
    border: '1px solid var(--sk-border, #d8dee4)',
    borderRadius: 'var(--sk-radius-sm, 4px)',
    background: 'var(--sk-elevated, #fff)',
    color: 'var(--sk-accent, #0056b2)',
    font: '500 11px/1.4 var(--sk-font-sans, sans-serif)',
    cursor: 'pointer',
    padding: '1px 6px',
    verticalAlign: 'middle',
  },
  '.sk-dnd-paste-btn:hover': { background: 'var(--sk-selection, rgba(9,105,218,.14))' },
});

/* ============================================================================
 * Public factory
 * ========================================================================== */

/**
 * @param {{ onNotice?: (notice: { message: string, level: 'warning' }) => void }} opts
 * @returns {import('@codemirror/state').Extension[]}
 */
export function dndExtension({ onNotice } = {}) {
  return [
    dndTheme,
    dragChipPlugin,
    hintField,
    pasteField,
    pasteExpiryPlugin,
    dismissOnEscape,
    makeDomEventHandlers(onNotice),
  ];
}
