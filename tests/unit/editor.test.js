// tests/unit/editor.test.js  (WP-2.3)
//
// Two groups:
//   1. Command transforms as pure EditorState round-trips: build a state
//      (+ a detached EditorView so commands can `view.dispatch`), run a
//      command, assert the resulting doc/selection. Tests that need
//      list/heading/indent context install the same Markdown language the
//      real editor uses; tests that are pure text surgery (bold/italic/
//      link) use a bare state — the commands don't need a syntax tree.
//   2. createEditor() smoke test: mounts in a detached div, getContent/
//      setContent round-trip, doc:changed (+ editor:wordcount/editor:cursor)
//      fire on the bus.
//
// app.js auto-boot is gated on #editor-mount (absent on this harness page);
// __SK_NO_AUTOBOOT is set anyway, matching scaffold.test.js's belt-and-
// braces guard, since editor.js imports app.js for the shared bus.
window.__SK_NO_AUTOBOOT = true;

import { describe, it, assert } from './runner.js';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';

import { bus } from '../../editor/app.js';
import { createEditor } from '../../editor/editor.js';
import {
  toggleBold, toggleItalic, insertLink, cycleHeading, editorKeymap,
  insertNewlineContinueMarkup,
} from '../../editor/commands.js';

// ── helpers ─────────────────────────────────────────────────────────────
function mkView(doc, sel, extensions = []) {
  const state = EditorState.create({
    doc,
    selection: sel ? EditorSelection.single(sel.anchor, sel.head ?? sel.anchor) : undefined,
    extensions,
  });
  return new EditorView({ state, parent: document.createElement('div') });
}

const mdExt = () => markdown({ base: markdownLanguage });

// ─────────────────────────────────────────────────────────────────────────
describe('commands: toggleBold (⌘B)', () => {
  it('wraps a selection in **…**', () => {
    const view = mkView('hello world', { anchor: 6, head: 11 }); // "world"
    toggleBold(view);
    assert.equal(view.state.doc.toString(), 'hello **world**');
    assert.equal(view.state.selection.main.from, 8);
    assert.equal(view.state.selection.main.to, 13);
    assert.equal(view.state.sliceDoc(8, 13), 'world');
  });

  it('wraps the word at a bare cursor', () => {
    const view = mkView('hello world', { anchor: 8 }); // cursor inside "world"
    toggleBold(view);
    assert.equal(view.state.doc.toString(), 'hello **world**');
  });

  it('untoggles a wrapped selection (idempotent round trip)', () => {
    const view = mkView('hello world', { anchor: 6, head: 11 });
    toggleBold(view);
    assert.equal(view.state.doc.toString(), 'hello **world**');
    toggleBold(view);
    assert.equal(view.state.doc.toString(), 'hello world');
    assert.equal(view.state.selection.main.from, 6);
    assert.equal(view.state.selection.main.to, 11);
  });

  it('untoggles an empty marker pair at a bare cursor', () => {
    const view = mkView('a **** b', { anchor: 4 }); // "a **|** b"
    toggleBold(view);
    assert.equal(view.state.doc.toString(), 'a  b');
  });
});

describe('commands: toggleItalic (⌘I)', () => {
  it('wraps a selection in *…*', () => {
    const view = mkView('hello world', { anchor: 6, head: 11 });
    toggleItalic(view);
    assert.equal(view.state.doc.toString(), 'hello *world*');
  });

  it('untoggles a wrapped selection (idempotent round trip)', () => {
    const view = mkView('hello world', { anchor: 6, head: 11 });
    toggleItalic(view);
    toggleItalic(view);
    assert.equal(view.state.doc.toString(), 'hello world');
  });
});

describe('commands: insertLink (⌘⇧L — WP-6.1 remap; ⌘K now opens the command palette)', () => {
  it('wraps the selection as [sel]() with the cursor inside the url', () => {
    const view = mkView('check this out', { anchor: 6, head: 10 }); // "this"
    insertLink(view);
    assert.equal(view.state.doc.toString(), 'check [this]() out');
    const pos = view.state.selection.main.head;
    assert.equal(pos, 13, 'cursor should sit just inside the parens');
    assert.equal(view.state.sliceDoc(pos - 1, pos + 1), '()');
  });

  it('produces []() with an empty selection', () => {
    const view = mkView('note here', { anchor: 4 });
    insertLink(view);
    assert.equal(view.state.doc.toString(), 'note[]() here');
  });

  it('editorKeymap binds insertLink to Mod-Shift-l, NOT Mod-k (WP-6.1: ⌘K is now the command palette)', () => {
    const linkBinding = editorKeymap.find((b) => b.run === insertLink);
    assert.ok(linkBinding, 'expected an editorKeymap entry running insertLink');
    assert.equal(linkBinding.key, 'Mod-Shift-l');
    assert.ok(!editorKeymap.some((b) => b.key === 'Mod-k'), 'Mod-k must be free for the command palette');
  });
});

describe('commands: cycleHeading', () => {
  it('cycles ## → ### → #### → none → ## on the current line', () => {
    const view = mkView('Title line', { anchor: 0 });
    cycleHeading(view);
    assert.equal(view.state.doc.toString(), '## Title line');
    cycleHeading(view);
    assert.equal(view.state.doc.toString(), '### Title line');
    cycleHeading(view);
    assert.equal(view.state.doc.toString(), '#### Title line');
    cycleHeading(view);
    assert.equal(view.state.doc.toString(), 'Title line', 'full cycle returns to no heading');
    cycleHeading(view);
    assert.equal(view.state.doc.toString(), '## Title line', 'cycle repeats');
  });

  it('treats an out-of-cycle level (H1) as entering at ##', () => {
    const view = mkView('# Title', { anchor: 0 });
    cycleHeading(view);
    assert.equal(view.state.doc.toString(), '## Title');
  });
});

describe('commands: Markdown list continuation on Enter', () => {
  it('continues a bullet list item', () => {
    const view = mkView('- item one', { anchor: 10 }, [mdExt()]);
    insertNewlineContinueMarkup(view);
    assert.equal(view.state.doc.toString(), '- item one\n- ');
    assert.equal(view.state.selection.main.head, view.state.doc.length);
  });

  it('continues an ordered list item with incremented numbering', () => {
    const view = mkView('1. item one', { anchor: 11 }, [mdExt()]);
    insertNewlineContinueMarkup(view);
    assert.equal(view.state.doc.toString(), '1. item one\n2. ');
  });
});

describe('commands: Tab / Shift-Tab indent', () => {
  const tabBinding = editorKeymap.find((b) => b.key === 'Tab');

  it('exposes a Tab binding with a shift (outdent) counterpart', () => {
    assert.ok(tabBinding && typeof tabBinding.run === 'function');
    assert.ok(typeof tabBinding.shift === 'function');
  });

  it('indents then outdents a list line back to its original text', () => {
    const doc = '- item one\n- item two';
    const line2 = doc.indexOf('- item two');
    const view = mkView(doc, { anchor: line2, head: line2 + '- item two'.length }, [mdExt()]);
    tabBinding.run(view);
    const afterIndent = view.state.doc.toString();
    assert.ok(afterIndent !== doc, 'indentMore should change the doc');
    assert.ok(afterIndent.endsWith('- item two'), 'original line text preserved');
    tabBinding.shift(view);
    assert.equal(view.state.doc.toString(), doc, 'indentLess restores the original doc');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('editor.js: front matter language (FR-EDIT.1/7)', () => {
  function frontmatterNodes(doc) {
    const state = EditorState.create({
      doc,
      extensions: [yamlFrontmatter({ content: mdExt() })],
    });
    const seen = new Set();
    syntaxTree(state).iterate({ enter: (n) => seen.add(n.name) });
    return seen;
  }

  it('parses a leading --- block as Frontmatter with YAML content', () => {
    // The mounted YAML parse (@lezer/yaml's own grammar) supersedes the
    // outer "FrontmatterContent" placeholder node in the materialized tree
    // (that's how @lezer/common's parseMixed mounts work — the mount point
    // is transparently replaced by the nested parser's own tree, so the
    // wrapper node name itself never shows up in a walk). What's directly
    // observable and what actually matters — the block is highlighted and
    // structurally understood as YAML — is: a Frontmatter node bounded by
    // DashLine markers, wrapping real YAML nodes (BlockMapping/Key/Pair),
    // with the post-`---` content still parsing as ordinary Markdown.
    const nodes = frontmatterNodes('---\ntitle: Hello\ndate: 2026-01-10\n---\n\n# Body\n');
    assert.ok(nodes.has('Frontmatter'), 'expected a Frontmatter node');
    assert.ok(nodes.has('DashLine'), 'expected DashLine node(s) bounding the block');
    assert.ok(nodes.has('BlockMapping') && nodes.has('Key') && nodes.has('Pair'),
      'expected the front-matter body to be parsed by the YAML grammar (BlockMapping/Key/Pair)');
    assert.ok(nodes.has('ATXHeading1'),
      'expected the body after the closing --- to still parse as Markdown');
  });

  it('parses a document with no leading --- entirely as Body (no Frontmatter node)', () => {
    const nodes = frontmatterNodes('# Just a heading\n\nSome body text.\n');
    assert.ok(!nodes.has('Frontmatter'), 'unexpected Frontmatter node with no leading ---');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('createEditor(): smoke test', () => {
  it('mounts in a detached div and exposes the frozen return shape', () => {
    const parent = document.createElement('div');
    const ed = createEditor({ parent, initialContent: '# hi\n' });
    try {
      assert.ok(ed.view instanceof EditorView);
      assert.equal(typeof ed.getContent, 'function');
      assert.equal(typeof ed.setContent, 'function');
      assert.equal(typeof ed.focus, 'function');
      assert.equal(typeof ed.destroy, 'function');
      assert.equal(ed.getContent(), '# hi\n');
    } finally {
      ed.destroy();
    }
  });

  it('getContent/setContent round-trip', () => {
    const parent = document.createElement('div');
    const ed = createEditor({ parent, initialContent: 'one' });
    try {
      ed.setContent('two');
      assert.equal(ed.getContent(), 'two');
    } finally {
      ed.destroy();
    }
  });

  it('does not throw on focus() even when detached from the document', () => {
    const parent = document.createElement('div');
    const ed = createEditor({ parent });
    try {
      ed.focus();
    } finally {
      ed.destroy();
    }
  });

  it('splices extraExtensions in (e.g. a custom theme wins as the last extension)', () => {
    const parent = document.createElement('div');
    const ed = createEditor({
      parent,
      initialContent: 'x',
      extraExtensions: [EditorView.editable.of(false)],
    });
    try {
      assert.equal(ed.view.state.facet(EditorView.editable), false);
    } finally {
      ed.destroy();
    }
  });

  it('emits doc:changed (debounced) and editor:wordcount with the new content', async () => {
    const parent = document.createElement('div');
    const ed = createEditor({ parent, initialContent: '' });
    try {
      const changed = new Promise((resolve) => {
        bus.addEventListener('doc:changed', (e) => resolve(e.detail), { once: true });
      });
      const wordcount = new Promise((resolve) => {
        bus.addEventListener('editor:wordcount', (e) => resolve(e.detail), { once: true });
      });
      ed.view.dispatch({ changes: { from: 0, insert: 'hello world' } });
      const [changedDetail, wordcountDetail] = await Promise.all([changed, wordcount]);
      assert.equal(changedDetail.content, 'hello world');
      assert.equal(wordcountDetail.words, 2);
    } finally {
      ed.destroy();
    }
  }, { timeout: 2000 });

  it('emits editor:cursor synchronously on selection changes', async () => {
    const parent = document.createElement('div');
    const ed = createEditor({ parent, initialContent: 'line one\nline two' });
    try {
      const cursor = new Promise((resolve) => {
        bus.addEventListener('editor:cursor', (e) => resolve(e.detail), { once: true });
      });
      const line2Start = ed.getContent().indexOf('line two');
      ed.view.dispatch({ selection: { anchor: line2Start + 3 } });
      const detail = await cursor;
      assert.equal(detail.line, 2);
      assert.equal(detail.col, 4);
    } finally {
      ed.destroy();
    }
  }, { timeout: 2000 });
});
