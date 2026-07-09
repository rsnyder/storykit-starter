/**
 * editor/lang-storykit.js — StoryKit/Liquid CM6 language extension (WP-2.4)
 *
 * FROZEN CONTRACT: docs/editor-plan.md §1.2.
 *
 *   storykit({ catalog, getIncludeList, getDocViewerIds }) -> Extension[]
 *
 * Delivers, as composable CM6 extensions:
 *   - FR-EDIT.2 highlighting: distinct tokens for {% %} delimiters, the
 *     `include`/`raw`/`endraw` keyword, the include path, attribute names,
 *     attribute values, and kramdown IAL blocks `{: ... }`. Implemented as a
 *     viewport-scoped decoration ViewPlugin driven by a hand-rolled scanner
 *     that handles MULTI-LINE `{% include ... %}` tags (their attribute values,
 *     e.g. map `markers=`, can themselves span lines). The scanner runs over
 *     the visible ranges backed up by MAX_TAG_SPAN chars so a tag whose `{%`
 *     is just above the viewport is still tokenised — MatchDecorator is
 *     line-based and cannot do this, hence the custom scanner.
 *   - FR-EDIT.3 autocomplete: a completion source (registered via
 *     EditorState.languageData so it composes with lang-markdown's own
 *     completions rather than overriding them) active inside `{% include … %}`.
 *   - FR-EDIT.4 lint: a linter() source (debounced, off the keystroke path).
 *   - FR-EDIT.5 QID decoration + an injected entity-label resolver hook.
 *   - FR-EDIT.7 front-matter YAML diagnostics.
 *
 * Styling uses CSS classes prefixed `sk-liquid-*` / `sk-qid-link` /
 * `sk-action-link`, coloured from the `--sk-*` token palette via an
 * EditorView.baseTheme (no styles.css edit required).
 *
 * ---------------------------------------------------------------------------
 * ENTITY RESOLVER HOOK (consumed by WP-4.2 wikidata.js)
 *
 *   storykit.setEntityResolver(fn)
 *     fn: (qid: string) => { label?: string, description?: string } | null
 *     Called SYNCHRONOUSLY while building QID decorations for each
 *     `[text](Qxxxx)` link in the viewport. A returned {label} adds
 *     title="label — description" and a data-qid-label attribute to the
 *     `sk-qid-link` decoration; returning null/undefined leaves just the base
 *     class + data-qid. WP-4.2 should back this with entityCache (a fast, sync
 *     cache read) and, after an async fetch populates the cache, dispatch a
 *     transaction carrying storykit.refreshEntities.of(null) to force the
 *     decoration ViewPlugin to recompute titles for the now-known QIDs.
 *
 *   storykit.refreshEntities   — a StateEffectType<null>; dispatch it to
 *                                trigger a decoration rebuild without a doc edit.
 * ---------------------------------------------------------------------------
 */

import { EditorView, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, StateEffect } from '@codemirror/state';
import { linter } from '@codemirror/lint';
import { parser as yamlParser } from '@lezer/yaml';
import { load as yamlLoad } from 'js-yaml';

/* ==========================================================================
 * Constants & shared decoration specs
 * ========================================================================== */

// How far above a visible range to start scanning so a multi-line tag whose
// `{%` sits just above the viewport is still recognised. Comfortably larger
// than any realistic include tag.
const MAX_TAG_SPAN = 4000;

const CURLY_QUOTES = '“”‘’'; // “ ” ‘ ’

const DECO = {
  delim: Decoration.mark({ class: 'sk-liquid-delim' }),
  keyword: Decoration.mark({ class: 'sk-liquid-keyword' }),
  raw: Decoration.mark({ class: 'sk-liquid-raw' }),
  path: Decoration.mark({ class: 'sk-liquid-path' }),
  attr: Decoration.mark({ class: 'sk-liquid-attr' }),
  value: Decoration.mark({ class: 'sk-liquid-value' }),
  ial: Decoration.mark({ class: 'sk-liquid-ial' }),
  action: Decoration.mark({ class: 'sk-action-link' }),
};

/** Dispatch this effect to force a decoration recompute (entity labels). */
export const refreshEntities = StateEffect.define();

// Module-level entity-label resolver, injected by WP-4.2 via
// storykit.setEntityResolver(). Read synchronously during QID decoration.
let entityResolver = null;

/* ==========================================================================
 * Dependency normalisation
 * ========================================================================== */

function buildActionSet(catalog) {
  const set = new Set();
  for (const viewer of Object.values(catalog || {})) {
    if (viewer && viewer.actions) {
      for (const action of Object.keys(viewer.actions)) set.add(action);
    }
  }
  return set;
}

/**
 * @param {{catalog?:object, getIncludeList?:()=>string[], getDocViewerIds?:()=>string[], docViewerIds?:string[]}} deps
 */
function normalize(deps = {}) {
  const catalog = deps.catalog || {};
  let list = null;
  if (typeof deps.getIncludeList === 'function') {
    try { list = deps.getIncludeList(); } catch { list = null; }
  } else if (Array.isArray(deps.includeList)) {
    list = deps.includeList;
  }
  const haveIncludeList = Array.isArray(list);
  const includeSet = new Set(haveIncludeList ? list : Object.keys(catalog));
  return {
    catalog,
    includeSet,
    haveIncludeList,
    actionSet: buildActionSet(catalog),
  };
}

/* ==========================================================================
 * Scanner — the shared tag/IAL/link grammar used by highlight, lint, complete
 *
 * All scan functions take (text, base=0) and return absolute positions
 * (base + local). The ViewPlugin passes a viewport slice + its absolute start
 * as `base`; lint/tests pass the whole document with base=0.
 * ========================================================================== */

const TAG_RE = /\{%(-?)([\s\S]*?)(-?)%\}/g;
const ATTR_RE = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
const IAL_RE = /\{:\s*([^}\n]*)\}/g;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/**
 * Scan Liquid tags. Returns tokens:
 *   { type:'include'|'raw'|'endraw'|'other',
 *     openFrom, openTo, closeFrom, closeTo,
 *     keyword, keywordFrom, keywordTo,
 *     path?, pathFrom?, pathTo?,
 *     attrs?: [{name,nameFrom,nameTo,value,valueFrom,valueTo,quote}] }
 */
export function scanTags(text, base = 0) {
  const tags = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text))) {
    const full = m[0];
    const openDash = m[1] || '';
    const closeDash = m[3] || '';
    const openFrom = base + m.index;
    const openTo = openFrom + 2 + openDash.length;
    const closeTo = base + m.index + full.length;
    const closeFrom = closeTo - 2 - closeDash.length;
    const innerStart = openTo;
    const inner = m[2];

    const tag = { openFrom, openTo, closeFrom, closeTo, keyword: null, type: 'other' };

    const kw = /^(\s*)([A-Za-z_][\w-]*)/.exec(inner);
    if (kw) {
      const keyword = kw[2];
      tag.keyword = keyword;
      tag.keywordFrom = innerStart + kw[1].length;
      tag.keywordTo = tag.keywordFrom + keyword.length;
      if (keyword === 'include') tag.type = 'include';
      else if (keyword === 'raw') tag.type = 'raw';
      else if (keyword === 'endraw') tag.type = 'endraw';
    }

    if (tag.type === 'include') {
      tag.attrs = [];
      const afterKw = inner.slice(kw[0].length);
      const pathM = /^(\s*)(\S+)/.exec(afterKw);
      if (pathM) {
        tag.path = pathM[2];
        tag.pathFrom = innerStart + kw[0].length + pathM[1].length;
        tag.pathTo = tag.pathFrom + tag.path.length;
        // Parse attributes from just past the path.
        ATTR_RE.lastIndex = tag.pathTo - innerStart;
        let a;
        while ((a = ATTR_RE.exec(inner))) {
          const name = a[1];
          let value, quote;
          if (a[2] !== undefined) { value = a[2]; quote = '"'; }
          else if (a[3] !== undefined) { value = a[3]; quote = "'"; }
          else { value = a[4]; quote = ''; }
          const nameFrom = innerStart + a.index;
          const nameTo = nameFrom + name.length;
          const valTokenLen = value.length + (quote ? 2 : 0);
          const valueTo = innerStart + a.index + a[0].length;
          const valueFrom = valueTo - valTokenLen;
          tag.attrs.push({ name, nameFrom, nameTo, value, valueFrom, valueTo, quote });
        }
      }
    }
    tags.push(tag);
  }
  return tags;
}

/** Scan kramdown IAL blocks `{: ... }`. Returns [{from,to,inner}]. */
export function scanIAL(text, base = 0) {
  const out = [];
  IAL_RE.lastIndex = 0;
  let m;
  while ((m = IAL_RE.exec(text))) {
    out.push({ from: base + m.index, to: base + m.index + m[0].length, inner: m[1] });
  }
  return out;
}

/**
 * Scan `[text](url)` links. Returns { qidLinks, actionLinks }.
 *   qidLinks:    [{from,to,qid,urlFrom,urlTo}]
 *   actionLinks: [{from,to,id,action,args,urlFrom,urlTo,argsFrom}]
 * `actionSet` limits which second URL segments count as viewer actions.
 */
export function scanLinks(text, base = 0, actionSet = new Set()) {
  const qidLinks = [];
  const actionLinks = [];
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(text))) {
    const linkText = m[1];
    const url = m[2];
    const from = base + m.index;
    const to = from + m[0].length;
    const urlFrom = from + 1 + linkText.length + 2; // past `[text](`
    const urlTo = urlFrom + url.length;
    if (/^Q\d+$/.test(url)) {
      qidLinks.push({ from, to, qid: url, urlFrom, urlTo });
      continue;
    }
    const segs = url.split('/');
    if (segs.length >= 2 && actionSet.has(segs[1])) {
      const args = segs.slice(2).join('/');
      const argsFrom = urlFrom + segs[0].length + 1 + segs[1].length + (segs.length > 2 ? 1 : 0);
      actionLinks.push({ from, to, id: segs[0], action: segs[1], args, urlFrom, urlTo, argsFrom });
    }
  }
  return { qidLinks, actionLinks };
}

/** Pair `{% raw %}`…`{% endraw %}` into [start,end) intervals for suppression. */
function pairRawRegions(tags) {
  const intervals = [];
  let open = null;
  for (const t of tags) {
    if (t.type === 'raw') {
      if (open === null) open = t.closeTo;
    } else if (t.type === 'endraw') {
      if (open !== null) { intervals.push([open, t.openFrom]); open = null; }
    }
  }
  return intervals;
}

/* ==========================================================================
 * FR-EDIT.2 / FR-EDIT.5 — decoration building (pure, viewport-scannable)
 * ========================================================================== */

/**
 * Build a DecorationSet for `text`. Positions are absolute (base-offset for
 * viewport slices). Only decorations intersecting [from,to) are emitted.
 *
 * @param {string} text       source (may be a viewport slice)
 * @param {object} deps       storykit deps (for actionSet)
 * @param {number} base       absolute start offset of `text`
 * @param {number} from       viewport start (absolute)
 * @param {number} to         viewport end (absolute)
 * @param {Function|null} resolver  entity resolver override (defaults to module hook)
 */
export function buildDecorations(
  text,
  deps,
  base = 0,
  from = base,
  to = base + text.length,
  resolver = entityResolver
) {
  const { actionSet } = normalize(deps);
  const ranges = [];
  const push = (a, b, spec) => {
    if (b > a && b > from && a < to) ranges.push(spec.range(a, b));
  };

  for (const t of scanTags(text, base)) {
    push(t.openFrom, t.openTo, DECO.delim);
    push(t.closeFrom, t.closeTo, DECO.delim);
    if (t.keyword != null) {
      push(t.keywordFrom, t.keywordTo, t.type === 'raw' || t.type === 'endraw' ? DECO.raw : DECO.keyword);
    }
    if (t.type === 'include') {
      if (t.pathFrom != null) push(t.pathFrom, t.pathTo, DECO.path);
      for (const a of t.attrs) {
        push(a.nameFrom, a.nameTo, DECO.attr);
        if (a.valueFrom != null) push(a.valueFrom, a.valueTo, DECO.value);
      }
    }
  }

  for (const ial of scanIAL(text, base)) push(ial.from, ial.to, DECO.ial);

  const { qidLinks, actionLinks } = scanLinks(text, base, actionSet);
  for (const q of qidLinks) {
    const attributes = { 'data-qid': q.qid };
    if (resolver) {
      try {
        const info = resolver(q.qid);
        if (info && info.label) {
          attributes.title = info.description ? `${info.label} — ${info.description}` : info.label;
          attributes['data-qid-label'] = info.label;
        }
      } catch { /* resolver errors are non-fatal */ }
    }
    push(q.from, q.to, Decoration.mark({ class: 'sk-qid-link', attributes }));
  }
  for (const al of actionLinks) push(al.from, al.to, DECO.action);

  return Decoration.set(ranges, true);
}

function makeDecorationPlugin(deps) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.build(view);
      }
      update(u) {
        const entityRefresh = u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshEntities))
        );
        if (u.docChanged || u.viewportChanged || entityRefresh) {
          this.decorations = this.build(u.view);
        }
      }
      build(view) {
        const doc = view.state.doc;
        let set = Decoration.none;
        for (const { from, to } of view.visibleRanges) {
          const scanStart = Math.max(0, from - MAX_TAG_SPAN);
          const slice = doc.sliceString(scanStart, to);
          const part = buildDecorations(slice, deps, scanStart, from, to);
          set = set.update({ add: rangesOf(part), sort: true });
        }
        return set;
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Collect a DecorationSet's ranges into a plain array (for merging viewport slices).
function rangesOf(set) {
  const out = [];
  const iter = set.iter();
  while (iter.value) {
    out.push(iter.value.range(iter.from, iter.to));
    iter.next();
  }
  return out;
}

/* ==========================================================================
 * FR-EDIT.3 — autocomplete
 * ========================================================================== */

/** First required attribute of a viewer, or null. */
function primaryAttr(catalog, path) {
  const viewer = catalog[path];
  if (!viewer || !viewer.attrs) return null;
  for (const [name, spec] of Object.entries(viewer.attrs)) {
    if (spec.required) return name;
  }
  return null;
}

/**
 * Returns a CM6 completion source `(CompletionContext) => CompletionResult|null`
 * active inside `{% include … %}`.
 */
export function storykitCompletions(deps) {
  const { catalog, includeSet } = normalize(deps);
  const paths = [...includeSet].sort();

  const pathOptions = () =>
    paths.map((path) => ({
      label: path,
      type: 'class',
      detail: 'viewer',
      info: catalog[path] ? catalog[path].doc : undefined,
      apply: path,
    }));

  // Skeleton completions offered at `{% inc` / `{% ` — insert a ready-to-fill tag.
  const skeletonOptions = () =>
    paths.map((path) => ({
      label: `include ${path}`,
      type: 'keyword',
      detail: 'insert viewer',
      info: catalog[path] ? catalog[path].doc : undefined,
      apply: (view, _c, from, to) => {
        const primary = primaryAttr(catalog, path);
        const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + 8));
        const closeAhead = /^\s*-?%\}/.test(after);
        let insert;
        let cursor;
        if (primary) {
          const head = `include ${path} ${primary}="`;
          insert = head + '"' + (closeAhead ? '' : ' %}');
          cursor = from + head.length;
        } else {
          const head = `include ${path} `;
          insert = head + (closeAhead ? '' : '%}');
          cursor = from + head.length;
        }
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: cursor } });
      },
    }));

  const attrNameOptions = (path, used) => {
    const viewer = catalog[path];
    if (!viewer || !viewer.attrs) return [];
    return Object.entries(viewer.attrs)
      .filter(([name]) => !used.has(name))
      .map(([name, spec]) => ({
        label: name,
        type: spec.required ? 'property' : 'variable',
        detail: spec.required ? `${spec.type} · required` : spec.type,
        info: spec.doc,
        boost: spec.required ? 2 : 0,
        apply: (view, _c, from, to) => {
          const insert = `${name}=""`;
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + name.length + 2 },
          });
        },
      }));
  };

  const valueOptions = (path, attrName) => {
    const spec = catalog[path] && catalog[path].attrs && catalog[path].attrs[attrName];
    if (!spec) return null;
    if (spec.type === 'enum' && Array.isArray(spec.values)) {
      return spec.values.map((v) => ({ label: v, type: 'enum', apply: v }));
    }
    if (spec.type === 'boolean') {
      return ['true', 'false'].map((v) => ({ label: v, type: 'enum', apply: v }));
    }
    return null;
  };

  return (context) => {
    const { state, pos } = context;
    const before = state.sliceDoc(0, pos);
    const lastOpen = before.lastIndexOf('{%');
    if (lastOpen === -1) return null;
    const lastClose = before.lastIndexOf('%}');
    if (lastClose > lastOpen) return null; // cursor is not inside an open tag
    const tagInner = before.slice(lastOpen + 2);

    // Resolve the current tag's include path (may be to the right of cursor).
    const tagEnd = state.doc.toString().indexOf('%}', lastOpen);
    const tagText = state.sliceDoc(lastOpen, tagEnd === -1 ? state.doc.length : tagEnd);
    const pathM = /include\s+(\S+)/.exec(tagText);
    const path = pathM ? pathM[1] : null;

    // (1) enum / boolean value inside an unclosed double-quoted attribute value
    const valM = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)$/.exec(tagInner);
    if (valM && path) {
      const opts = valueOptions(path, valM[1]);
      if (opts) {
        return { from: pos - valM[2].length, options: opts, validFor: /^[^"]*$/ };
      }
      // Known attr but free-form value: nothing to offer.
      if (catalog[path] && catalog[path].attrs && catalog[path].attrs[valM[1]]) return null;
    }

    // (2) include path — cursor still inside the path token (no trailing space)
    const pathPhase = /include\s+([^\s"']*)$/.exec(tagInner);
    if (pathPhase) {
      return {
        from: pos - pathPhase[1].length,
        options: pathOptions(),
        validFor: /^[\w./-]*$/,
      };
    }

    // (3) attribute name — after the path, at a whitespace/word boundary
    const attrsPart = /include\s+\S+([\s\S]*)$/.exec(tagInner);
    if (attrsPart && path) {
      const region = attrsPart[1];
      const partialM = /([A-Za-z_][\w-]*)?$/.exec(region);
      const partial = partialM[1] || '';
      const prefix = region.slice(0, region.length - partial.length);
      // Skip if we're right after `=` (a value position without quotes).
      if (!/=\s*$/.test(prefix)) {
        const used = new Set();
        let a;
        ATTR_RE.lastIndex = 0;
        while ((a = ATTR_RE.exec(tagText))) used.add(a[1]);
        used.delete(partial);
        const options = attrNameOptions(path, used);
        if (options.length) {
          return { from: pos - partial.length, options, validFor: /^[\w-]*$/ };
        }
      }
      return null;
    }

    // (4) keyword / skeleton phase — `{% ` or `{% inc`
    const kwPhase = /^\s*([A-Za-z_][\w-]*)?$/.exec(tagInner);
    if (kwPhase) {
      const partial = kwPhase[1] || '';
      const options = skeletonOptions();
      options.push(
        { label: 'raw', type: 'keyword', detail: 'raw block', apply: 'raw %}' },
        { label: 'endraw', type: 'keyword', detail: 'end raw block', apply: 'endraw %}' }
      );
      return { from: pos - partial.length, options, validFor: /^[\w]*$/ };
    }

    return null;
  };
}

/* ==========================================================================
 * FR-EDIT.4 / FR-EDIT.7 — lint
 * ========================================================================== */

const NUM_RE = /^-?\d+(\.\d+)?$/;

function checkPctArity(argString) {
  const body = argString.replace(/^pct:/, '');
  const parts = body.split(',');
  if (parts.length !== 4) return false;
  return parts.every((p) => NUM_RE.test(p.trim()));
}

/**
 * Compute diagnostics for `text`. Pure — returns
 *   [{ from, to, severity:'error'|'warning', message }]
 * `deps.docViewerIds` (array) is used when present; otherwise ids are scanned
 * from the document's own include tags.
 */
// ── Front-matter schema (semantic layer on top of the YAML parse) ───────────
// Vocabulary derived from what the layouts/includes ACTUALLY read (page.*)
// in this starter and the Chirpy gem, plus Jekyll core keys — unknown keys
// get a did-you-mean WARNING (custom keys are legitimate, so never an error).
const FM_KNOWN_KEYS = new Set([
  'title', 'description', 'author', 'authors', 'date', 'last_modified_at',
  'categories', 'tags', 'layout', 'image', 'media_subpath', 'img_path',
  'toc', 'comments', 'math', 'mermaid', 'lang', 'storykit', 'published',
  'featured', 'hidden', 'pin', 'show_header_image', 'publisher', 'updated',
  'lightbox', 'format', 'permalink', 'order', 'excerpt', 'redirect_from',
  'render_with_liquid', 'sitemap',
]);
const FM_BOOLEAN_KEYS = new Set([
  'toc', 'comments', 'math', 'mermaid', 'published', 'featured', 'hidden',
  'pin', 'show_header_image', 'render_with_liquid',
]);

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

function didYouMean(key) {
  let best = null, bestD = 3;
  for (const k of FM_KNOWN_KEYS) {
    const d = editDistance(key.toLowerCase(), k);
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= 2 ? best : null;
}

/** Semantic front-matter checks (names + value shapes). `inner` is the YAML
 *  between the fences; `innerStart` its offset in the document. */
function checkFrontMatterSchema(inner, innerStart, diags) {
  let data;
  try { data = yamlLoad(inner); } catch { return; } // syntax errors reported elsewhere
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;

  // Map top-level keys to positions (indent-0 `key:` lines).
  const keyPos = new Map();
  let off = 0;
  for (const line of inner.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(line);
    if (m && !keyPos.has(m[1])) keyPos.set(m[1], { from: innerStart + off, to: innerStart + off + m[1].length });
    off += line.length + 1;
  }
  const at = (key) => keyPos.get(key) || { from: innerStart, to: innerStart + 3 };

  for (const [key, value] of Object.entries(data)) {
    if (!FM_KNOWN_KEYS.has(key)) {
      const hint = didYouMean(key);
      diags.push({
        ...at(key), severity: 'warning',
        message: `Unknown front-matter key "${key}"` + (hint ? ` — did you mean "${hint}"?` : ' — not read by any layout (custom keys are allowed; check the spelling).'),
      });
      continue;
    }
    if (key === 'image') {
      if (typeof value === 'string') {
        if (!value.trim()) diags.push({ ...at(key), severity: 'error', message: 'image is empty — give it a path or remove it (an empty value suppresses the header image).' });
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const path = value.path;
        if (path == null || String(path).trim() === '') {
          diags.push({ ...at(key), severity: 'error', message: 'image.path is empty — give it a value or remove the image block (the template ships it blank).' });
        }
      } else {
        diags.push({ ...at(key), severity: 'error', message: 'image should be a path string or a mapping with path/alt.' });
      }
      continue;
    }
    if ((key === 'categories' || key === 'tags')
        && !(typeof value === 'string' || Array.isArray(value) || value == null)) {
      diags.push({ ...at(key), severity: 'warning', message: `${key} should be a list (e.g. [a, b]) or a string.` });
      continue;
    }
    if (FM_BOOLEAN_KEYS.has(key) && value != null && typeof value !== 'boolean') {
      diags.push({ ...at(key), severity: 'warning', message: `${key} should be true or false (unquoted) — "${String(value)}" is a ${typeof value}.` });
      continue;
    }
    if (key === 'date' && value != null) {
      const str = value instanceof Date ? '' : String(value);
      if (str && !/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?( ?[+-]\d{4}| ?Z)?)?$/.test(str.trim())) {
        diags.push({ ...at(key), severity: 'warning', message: 'date should look like YYYY-MM-DD (optionally with a time) — Jekyll may ignore this value.' });
      }
    }
  }
}

// ── Markdown link syntax (unterminated destination) ─────────────────────────
/** Ranges to EXCLUDE from prose-level checks: fenced code blocks and inline
 *  code spans — documentation legitimately shows broken syntax there. */
function codeRanges(text) {
  const ranges = [];
  // fenced blocks
  const fence = /^(```|~~~).*$/gm;
  let open = null, m;
  while ((m = fence.exec(text)) !== null) {
    if (open === null) open = m.index;
    else { ranges.push([open, m.index + m[0].length]); open = null; }
  }
  if (open !== null) ranges.push([open, text.length]);
  // inline code spans (single line, non-greedy)
  const span = /`[^`\n]*`/g;
  while ((m = span.exec(text)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** Flag `[text](destination` that never closes before a blank line/EOF —
 *  markdown-it renders it as literal text, which authors read as "my link
 *  silently broke". Balanced parens inside the destination (Wikipedia URLs)
 *  are handled. */
function checkUnterminatedLinks(text, diags) {
  const excluded = codeRanges(text);
  const inCode = (p) => excluded.some(([a, b]) => p >= a && p < b);
  const opener = /\[([^\]\n]*)\]\(/g;
  let m;
  while ((m = opener.exec(text)) !== null) {
    if (inCode(m.index)) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '\n' && text[i + 1] === '\n') break; // paragraph end
      i++;
    }
    if (depth > 0) {
      diags.push({
        from: m.index, to: m.index + m[0].length,
        severity: 'error',
        message: 'Unclosed link — missing the closing ")" after the destination.',
      });
      opener.lastIndex = m.index + m[0].length;
    }
  }
}

export function computeDiagnostics(text, deps) {
  const { catalog, includeSet, haveIncludeList, actionSet } = normalize(deps);
  const diags = [];

  const tags = scanTags(text);
  const ials = scanIAL(text);
  const { actionLinks } = scanLinks(text, 0, actionSet);
  const rawRegions = pairRawRegions(tags);
  const inRaw = (p) => rawRegions.some(([a, b]) => p >= a && p < b);

  // Index kramdown IAL ids (for vis-network data-block resolution).
  const ialIds = new Set();
  for (const ial of ials) {
    const idm = /#([\w-]+)/.exec(ial.inner);
    if (idm) ialIds.add(idm[1]);
  }

  // Resolve document viewer ids.
  let ids = deps.docViewerIds;
  if (!Array.isArray(ids)) {
    if (typeof deps.getDocViewerIds === 'function') {
      try { ids = deps.getDocViewerIds(); } catch { ids = null; }
    }
  }
  if (!Array.isArray(ids)) {
    ids = [];
    for (const t of tags) {
      if (t.type === 'include' && t.attrs) {
        const id = t.attrs.find((a) => a.name === 'id');
        if (id) ids.push(id.value);
      }
    }
  }
  const idSet = new Set(ids);

  // ---- Front matter (FR-EDIT.7) -----------------------------------------
  lintFrontMatter(text, diags);
  checkUnterminatedLinks(text, diags);

  // ---- Tag diagnostics --------------------------------------------------
  for (const t of tags) {
    if (inRaw(t.openFrom)) continue;

    // Curly quotes anywhere inside the tag (the #1 author footgun) — error.
    const tagSlice = text.slice(t.openFrom, t.closeTo);
    for (let i = 0; i < tagSlice.length; i++) {
      if (CURLY_QUOTES.includes(tagSlice[i])) {
        const at = t.openFrom + i;
        diags.push({
          from: at,
          to: at + 1,
          severity: 'error',
          message: 'Curly quote inside a Liquid tag — replace with a straight quote (").',
        });
      }
    }

    // Unbalanced straight quotes (e.g. a missing trailing quote on an
    // attribute value) silently corrupt every attribute after the gap —
    // flag the tag itself with an error before attr-level checks run on
    // garbage. Curly quotes are already flagged above; count only straight.
    {
      let straight = 0;
      for (let i = 0; i < tagSlice.length; i++) if (tagSlice[i] === '"') straight++;
      if (straight % 2 === 1) {
        diags.push({
          from: t.openFrom,
          to: t.closeTo,
          severity: 'error',
          message: 'Unbalanced quote in this tag — an attribute value is missing its closing ".',
        });
      }
    }

    if (t.type !== 'include' || t.path == null) continue;
    const known = includeSet.has(t.path);

    if (!known) {
      // Only flag genuine unknowns: with a repo include list, anything absent
      // is unknown; without one (bundled fallback), only judge embed/ paths.
      if (haveIncludeList || t.path.startsWith('embed/')) {
        diags.push({
          from: t.pathFrom,
          to: t.pathTo,
          severity: 'error',
          message: `Unknown include path "${t.path}".`,
        });
      }
      continue;
    }

    const viewer = catalog[t.path];
    if (!viewer) continue;
    const attrSpecs = viewer.attrs || {};
    const present = new Set();

    for (const a of t.attrs) {
      present.add(a.name);
      if (!(a.name in attrSpecs)) {
        diags.push({
          from: a.nameFrom,
          to: a.nameTo,
          severity: 'warning',
          message: `Unknown attribute "${a.name}" for ${t.path}.`,
        });
      }
      // region="pct:…" arity — error on wrong arity.
      if (a.name === 'region' && /^pct:/.test(a.value) && !checkPctArity(a.value)) {
        diags.push({
          from: a.valueFrom,
          to: a.valueTo,
          severity: 'error',
          message: 'Malformed region — pct: expects exactly four numbers (pct:x,y,w,h).',
        });
      }
    }

    // Missing required attributes — error.
    for (const [name, spec] of Object.entries(attrSpecs)) {
      if (spec.required && !present.has(name)) {
        diags.push({
          from: t.pathFrom,
          to: t.pathTo,
          severity: 'error',
          message: `Missing required attribute "${name}" for ${t.path}.`,
        });
      }
    }

    // vis-network must have a matching `{: #<id>-csv }` (or dataid) data block.
    if (t.path === 'embed/vis-network.html') {
      const idAttr = t.attrs.find((a) => a.name === 'id');
      const dataAttr = t.attrs.find((a) => a.name === 'dataid');
      const expected = dataAttr ? dataAttr.value : idAttr ? `${idAttr.value}-csv` : null;
      if (expected && !ialIds.has(expected)) {
        diags.push({
          from: t.openFrom,
          to: t.closeTo,
          severity: 'warning',
          message: `vis-network data block "{: #${expected} }" not found in this document.`,
        });
      }
    }
  }

  // ---- Action links -----------------------------------------------------
  for (const al of actionLinks) {
    if (inRaw(al.from)) continue;
    if (!idSet.has(al.id)) {
      diags.push({
        from: al.urlFrom,
        to: al.urlTo,
        severity: 'warning',
        message: `Action link targets id "${al.id}", which no viewer in this document declares.`,
      });
    }
    if (al.action === 'zoomto' && al.args && !checkPctArity(al.args)) {
      diags.push({
        from: al.argsFrom,
        to: al.urlTo,
        severity: 'error',
        message: 'zoomto expects four comma-separated numbers (pct:x,y,w,h).',
      });
    }
  }

  return diags;
}

function lintFrontMatter(text, diags) {
  if (!/^---[ \t]*(\r?\n|$)/.test(text)) return;
  const firstNL = text.indexOf('\n');
  if (firstNL === -1) return;

  // Locate the closing --- (or ...) fence.
  const closeRe = /\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/g;
  closeRe.lastIndex = firstNL;
  const close = closeRe.exec(text);
  if (!close) {
    diags.push({
      from: 0,
      to: 3,
      severity: 'error',
      message: 'Unclosed front-matter block — add a closing "---" line.',
    });
    return;
  }

  const innerStart = firstNL + 1;
  const innerEnd = close.index; // position of the newline before the closing fence
  const inner = text.slice(innerStart, innerEnd);

  // Tab characters break YAML indentation — warn.
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\t') {
      const at = innerStart + i;
      diags.push({
        from: at,
        to: at + 1,
        severity: 'warning',
        message: 'Tab character in front matter — YAML indentation must use spaces.',
      });
    }
  }

  // Structural YAML parse via the lezer parser — surface real syntax errors.
  try {
    const tree = yamlParser.parse(inner);
    const cursor = tree.cursor();
    let reported = 0;
    do {
      if (cursor.type.isError && reported < 5) {
        const at = innerStart + cursor.from;
        diags.push({
          from: at,
          to: innerStart + Math.max(cursor.to, cursor.from + 1),
          severity: 'error',
          message: 'YAML syntax error in front matter.',
        });
        reported++;
      }
    } while (cursor.next());
  } catch { /* parser unavailable — tab/close checks still ran */ }

  // Semantic layer: key names (did-you-mean) + value shapes.
  checkFrontMatterSchema(inner, innerStart, diags);
}

/* ==========================================================================
 * Public factory
 * ========================================================================== */

/**
 * @param {{
 *   catalog: object,
 *   getIncludeList?: () => string[],
 *   getDocViewerIds?: () => string[],
 * }} deps
 * @returns {import('@codemirror/state').Extension[]}
 */
export function storykit(deps = {}) {
  if (!deps.catalog) return []; // inert without a catalog (stub-compatible)

  const baseTheme = EditorView.baseTheme({
    '.sk-liquid-delim': { color: 'var(--sk-text-faint)', fontWeight: '600' },
    '.sk-liquid-keyword': { color: 'var(--sk-accent)', fontWeight: '600' },
    '.sk-liquid-raw': { color: 'var(--sk-accent)', fontStyle: 'italic', fontWeight: '600' },
    '.sk-liquid-path': { color: 'var(--sk-success)' },
    '.sk-liquid-attr': { color: 'var(--sk-warning)' },
    '.sk-liquid-value': { color: 'var(--sk-text-muted)' },
    '.sk-liquid-ial': { color: 'var(--sk-accent-hover)', fontStyle: 'italic' },
    '.sk-qid-link': {
      textDecoration: 'underline dotted',
      textDecorationColor: 'var(--sk-accent)',
      textUnderlineOffset: '2px',
    },
    '.sk-action-link': {
      textDecoration: 'underline dotted',
      textDecorationColor: 'var(--sk-success)',
      textUnderlineOffset: '2px',
    },
  });

  const decorationPlugin = makeDecorationPlugin(deps);

  const completionSource = storykitCompletions(deps);
  const completionExt = EditorState.languageData.of(() => [{ autocomplete: completionSource }]);

  const lintExt = linter(
    (view) => {
      const text = view.state.doc.toString();
      const diags = computeDiagnostics(text, deps);
      // Report the count outward (host emits the frozen `lint:count` bus
      // event — the status bar's counter listened for it since M2 but
      // nothing ever emitted it; it read "0 issues" regardless).
      if (typeof deps.onLintCount === 'function') {
        try { deps.onLintCount(diags.length); } catch { /* host's problem */ }
      }
      return diags;
    },
    { delay: 400 }
  );

  return [baseTheme, decorationPlugin, completionExt, lintExt];
}

/** WP-4.2 entity-label resolver injection hook (see file header). */
storykit.setEntityResolver = function setEntityResolver(fn) {
  entityResolver = typeof fn === 'function' ? fn : null;
};

/** Exposed so WP-4.2 can dispatch a decoration refresh after async loads. */
storykit.refreshEntities = refreshEntities;
