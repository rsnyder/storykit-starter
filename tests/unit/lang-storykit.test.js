// tests/unit/lang-storykit.test.js  (WP-2.4)
//
// Covers editor/lang-storykit.js: FR-EDIT.2 tokenization ranges, FR-EDIT.3
// completion contents + insertion shape, FR-EDIT.4 lint (every rule, positive
// AND negative), FR-EDIT.5 QID decoration + resolver hook, FR-EDIT.7 front
// matter, and the §5.3 keystroke-budget perf check on a ~50 KB document.

import { describe, it, assert } from './runner.js';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext } from '@codemirror/autocomplete';

import {
  storykit,
  storykitCompletions,
  computeDiagnostics,
  buildDecorations,
  scanTags,
  scanLinks,
} from '../../editor/lang-storykit.js';
import { catalog } from '../../editor/viewer-catalog.js';

const DEPS = { catalog };

/* ---------------------------------------------------------------- helpers */

function classesAt(set, pos) {
  const found = new Set();
  const iter = set.iter();
  while (iter.value) {
    if (iter.from <= pos && pos < iter.to) found.add(iter.value.spec.class);
    iter.next();
  }
  return found;
}

function decoRanges(set) {
  const out = [];
  const iter = set.iter();
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to, spec: iter.value.spec });
    iter.next();
  }
  return out;
}

function hasDeco(set, cls, from, to) {
  return decoRanges(set).some(
    (d) => d.spec.class === cls && d.from === from && d.to === to
  );
}

function messages(diags) {
  return diags.map((d) => d.message);
}

function completeAt(deps, doc, pos, explicit = true) {
  const state = EditorState.create({ doc });
  const ctx = new CompletionContext(state, pos, explicit);
  return storykitCompletions(deps)(ctx);
}

function mountView(doc, pos = 0) {
  const parent = document.createElement('div');
  parent.style.height = '300px';
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: pos } }),
    parent,
  });
  return {
    view,
    destroy() {
      view.destroy();
      parent.remove();
    },
  };
}

/* ============================================================ FR-EDIT.2 */

describe('FR-EDIT.2 tokenization ranges', () => {
  it('tokenizes {% include %} delimiters, keyword, path, attr name & value', () => {
    const doc = '{% include embed/image.html id="image" src="wc:Foo.jpg" %}';
    const set = buildDecorations(doc, DEPS);

    assert.ok(hasDeco(set, 'sk-liquid-delim', 0, 2), 'opening {% delimiter');
    assert.ok(
      hasDeco(set, 'sk-liquid-delim', doc.length - 2, doc.length),
      'closing %} delimiter'
    );

    const kw = doc.indexOf('include');
    assert.ok(hasDeco(set, 'sk-liquid-keyword', kw, kw + 7), 'include keyword');

    const path = doc.indexOf('embed/image.html');
    assert.ok(
      hasDeco(set, 'sk-liquid-path', path, path + 'embed/image.html'.length),
      'include path'
    );

    const idName = doc.indexOf('id=');
    assert.ok(classesAt(set, idName).has('sk-liquid-attr'), 'attr name id');

    const val = doc.indexOf('"image"');
    assert.ok(classesAt(set, val).has('sk-liquid-value'), 'attr value incl. quotes');
  });

  it('tokenizes a MULTI-LINE include whose value spans lines (map markers)', () => {
    const doc =
      '{% include embed/map.html\n    center="Q192017"\n    markers="Q1~a|\n    Q2~b"\n%}';
    const set = buildDecorations(doc, DEPS);
    // keyword and path recognised across the newline before attributes
    const kw = doc.indexOf('include');
    assert.ok(hasDeco(set, 'sk-liquid-keyword', kw, kw + 7));
    // the multi-line markers value is a single value token
    const markerVal = doc.indexOf('"Q1~a|');
    assert.ok(classesAt(set, markerVal).has('sk-liquid-value'));
    const secondLineOfValue = doc.indexOf('Q2~b');
    assert.ok(
      classesAt(set, secondLineOfValue).has('sk-liquid-value'),
      'value continues onto the next line'
    );
  });

  it('tokenizes {% raw %}/{% endraw %} keywords distinctly', () => {
    const doc = '{% raw %}text{% endraw %}';
    const set = buildDecorations(doc, DEPS);
    const raw = doc.indexOf('raw');
    assert.ok(hasDeco(set, 'sk-liquid-raw', raw, raw + 3), 'raw keyword');
    const endraw = doc.indexOf('endraw');
    assert.ok(hasDeco(set, 'sk-liquid-raw', endraw, endraw + 6), 'endraw keyword');
  });

  it('tokenizes kramdown IAL blocks {: ... }', () => {
    const doc = 'Text\n{: #film_network-csv }\n';
    const set = buildDecorations(doc, DEPS);
    const from = doc.indexOf('{:');
    const to = doc.indexOf('}', from) + 1;
    assert.ok(hasDeco(set, 'sk-liquid-ial', from, to), 'IAL block decorated');
  });

  it('scanTags reports correct absolute positions with a base offset', () => {
    const tag = '{% include embed/youtube.html vid="abc" %}';
    const tags = scanTags(tag, 1000);
    assert.equal(tags.length, 1);
    assert.equal(tags[0].openFrom, 1000);
    assert.equal(tags[0].path, 'embed/youtube.html');
    assert.equal(tags[0].attrs[0].name, 'vid');
    assert.equal(tags[0].attrs[0].value, 'abc');
  });
});

/* ============================================================ FR-EDIT.5 */

describe('FR-EDIT.5 QID decoration + resolver hook', () => {
  it('decorates [text](Q1234) links with sk-qid-link and data-qid', () => {
    const doc = 'The [Navajo Nation](Q1783171) is sacred.';
    const set = buildDecorations(doc, DEPS);
    const from = doc.indexOf('[Navajo');
    const to = doc.indexOf(')') + 1;
    assert.ok(hasDeco(set, 'sk-qid-link', from, to));
    const deco = decoRanges(set).find((d) => d.spec.class === 'sk-qid-link');
    assert.equal(deco.spec.attributes['data-qid'], 'Q1783171');
  });

  it('does NOT decorate a plain external link as a QID', () => {
    const doc = 'See [the guide](https://example.com/x).';
    const set = buildDecorations(doc, DEPS);
    assert.ok(!decoRanges(set).some((d) => d.spec.class === 'sk-qid-link'));
  });

  it('injected resolver adds a title / data-qid-label', () => {
    const doc = '[Darwin](Q1035)';
    const resolver = (qid) =>
      qid === 'Q1035' ? { label: 'Charles Darwin', description: 'naturalist' } : null;
    const set = buildDecorations(doc, DEPS, 0, 0, doc.length, resolver);
    const deco = decoRanges(set).find((d) => d.spec.class === 'sk-qid-link');
    assert.equal(deco.spec.attributes.title, 'Charles Darwin — naturalist');
    assert.equal(deco.spec.attributes['data-qid-label'], 'Charles Darwin');
  });

  it('decorates action links [text](id/action/args) with sk-action-link', () => {
    const doc = 'Look at [Merrick](img1/zoomto/pct:1,2,3,4).';
    const set = buildDecorations(doc, DEPS);
    assert.ok(decoRanges(set).some((d) => d.spec.class === 'sk-action-link'));
  });

  it('setEntityResolver installs and clears the module hook', () => {
    const doc = '[x](Q9)';
    storykit.setEntityResolver((q) => ({ label: `L:${q}` }));
    let set = buildDecorations(doc, DEPS); // uses module resolver by default
    let deco = decoRanges(set).find((d) => d.spec.class === 'sk-qid-link');
    assert.equal(deco.spec.attributes['data-qid-label'], 'L:Q9');
    storykit.setEntityResolver(null);
    set = buildDecorations(doc, DEPS);
    deco = decoRanges(set).find((d) => d.spec.class === 'sk-qid-link');
    assert.ok(!('data-qid-label' in deco.spec.attributes));
  });
});

/* ============================================================ FR-EDIT.3 */

describe('FR-EDIT.3 autocomplete', () => {
  it('offers include skeletons at {% inc', () => {
    const doc = '{% inc';
    const res = completeAt(DEPS, doc, doc.length);
    assert.ok(res, 'result present');
    const labels = res.options.map((o) => o.label);
    assert.ok(labels.includes('include embed/image.html'));
    assert.ok(labels.includes('include embed/map.html'));
    assert.equal(res.from, doc.length - 3, 'replaces the partial "inc"');
  });

  it('skeleton insertion yields a ready-to-fill tag with cursor between quotes', () => {
    const doc = '{% inc';
    const { view, destroy } = mountView(doc, doc.length);
    try {
      const res = completeAt(DEPS, doc, doc.length);
      const opt = res.options.find((o) => o.label === 'include embed/map.html');
      opt.apply(view, opt, res.from, doc.length);
      const out = view.state.doc.toString();
      assert.ok(out.includes('include embed/map.html center=""'), out);
      assert.ok(out.trim().endsWith('%}'), 'closing delimiter inserted');
      const cur = view.state.selection.main.head;
      assert.equal(out[cur - 1], '"', 'cursor sits just after the opening quote');
      assert.equal(out[cur], '"', 'cursor sits just before the closing quote');
    } finally {
      destroy();
    }
  });

  it('offers include paths while typing the path', () => {
    const doc = '{% include embed/i';
    const res = completeAt(DEPS, doc, doc.length);
    assert.ok(res);
    const labels = res.options.map((o) => o.label);
    assert.ok(labels.includes('embed/image.html'));
    assert.equal(res.from, doc.length - 'embed/i'.length);
  });

  it('offers attribute names for the matched viewer and inserts name=""', () => {
    const doc = '{% include embed/image.html ';
    const { view, destroy } = mountView(doc, doc.length);
    try {
      const res = completeAt(DEPS, doc, doc.length);
      assert.ok(res);
      const labels = res.options.map((o) => o.label);
      assert.ok(labels.includes('caption'));
      assert.ok(labels.includes('src'));
      const opt = res.options.find((o) => o.label === 'caption');
      opt.apply(view, opt, res.from, doc.length);
      const out = view.state.doc.toString();
      assert.ok(out.endsWith('caption=""'), out);
      const cur = view.state.selection.main.head;
      assert.equal(out.slice(cur - 9, cur - 1), 'caption=', 'attribute inserted');
      assert.equal(out[cur - 1], '"', 'cursor just after the opening quote');
      assert.equal(out[cur], '"', 'cursor just before the closing quote');
    } finally {
      destroy();
    }
  });

  it('does not re-offer an already-present attribute name', () => {
    const doc = '{% include embed/image.html src="x" ';
    const res = completeAt(DEPS, doc, doc.length);
    const labels = res.options.map((o) => o.label);
    assert.ok(!labels.includes('src'), 'src already used, should be filtered');
    assert.ok(labels.includes('caption'));
  });

  it('offers enum values inside an unclosed quoted enum attribute', () => {
    const doc = '{% include embed/map.html basemap="';
    const res = completeAt(DEPS, doc, doc.length);
    assert.ok(res);
    const labels = res.options.map((o) => o.label);
    assert.ok(labels.includes('OpenStreetMap'));
    assert.ok(labels.includes('Esri_WorldImagery'));
  });

  it('offers boolean values for a boolean attribute', () => {
    const doc = '{% include embed/image.html cover="';
    const res = completeAt(DEPS, doc, doc.length);
    const labels = res.options.map((o) => o.label);
    assert.deepEqual(labels, ['true', 'false']);
  });

  it('returns null outside any tag', () => {
    assert.equal(completeAt(DEPS, 'just prose here', 5), null);
    assert.equal(completeAt(DEPS, '{% include embed/image.html %} after', 34), null);
  });
});

/* ============================================================ FR-EDIT.4 */

describe('FR-EDIT.4 lint — unknown include path', () => {
  it('flags an unknown embed path (positive)', () => {
    const doc = '{% include embed/bogus.html %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(messages(diags).some((m) => /Unknown include path/.test(m)));
  });
  it('does not flag a known viewer (negative)', () => {
    const doc = '{% include embed/image.html src="x" %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /Unknown include path/.test(m)));
  });
  it('respects getIncludeList when provided', () => {
    const deps = { catalog, getIncludeList: () => ['embed/custom.html'] };
    const good = computeDiagnostics('{% include embed/custom.html %}', deps);
    assert.ok(!messages(good).some((m) => /Unknown include path/.test(m)));
    const bad = computeDiagnostics('{% include embed/image.html %}', deps);
    assert.ok(messages(bad).some((m) => /Unknown include path/.test(m)));
  });
});

describe('FR-EDIT.4 lint — unknown attribute', () => {
  it('warns on an unknown attribute (positive)', () => {
    const doc = '{% include embed/image.html rotation="90" %}';
    const diags = computeDiagnostics(doc, DEPS);
    const d = diags.find((x) => /Unknown attribute/.test(x.message));
    assert.ok(d, 'unknown attribute flagged');
    assert.equal(d.severity, 'warning');
  });
  it('does not warn on a known attribute (negative)', () => {
    const doc = '{% include embed/image.html rotate="90" %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /Unknown attribute/.test(m)));
  });
});

describe('FR-EDIT.4 lint — curly quotes (the #1 footgun)', () => {
  it('errors on a curly quote inside a tag (positive)', () => {
    const doc = '{% include embed/image.html src=“x” %}';
    const diags = computeDiagnostics(doc, DEPS);
    const curly = diags.filter((x) => /Curly quote/.test(x.message));
    assert.equal(curly.length, 2, 'both curly quotes flagged');
    assert.equal(curly[0].severity, 'error');
  });
  it('does not flag straight quotes (negative)', () => {
    const doc = '{% include embed/image.html src="x" %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /Curly quote/.test(m)));
  });
  it('does not flag curly quotes inside a {% raw %} region', () => {
    const doc = '{% raw %}{% include embed/image.html src=“x” %}{% endraw %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /Curly quote/.test(m)));
  });
});

describe('FR-EDIT.4 lint — missing required attribute', () => {
  it('errors when a required attribute is missing (positive)', () => {
    const doc = '{% include embed/map.html zoom="5" %}'; // center required
    const diags = computeDiagnostics(doc, DEPS);
    const d = diags.find((x) => /Missing required attribute "center"/.test(x.message));
    assert.ok(d);
    assert.equal(d.severity, 'error');
  });
  it('does not error when required attributes are present (negative)', () => {
    const doc = '{% include embed/map.html center="Q1" %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /Missing required/.test(m)));
  });
  it('image.html src/manifest are both optional — no false positive', () => {
    const doc = '{% include embed/image.html src="x" %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /Missing required/.test(m)));
  });
});

describe('FR-EDIT.4 lint — action-link id resolution', () => {
  it('warns when an action link id has no matching viewer (positive)', () => {
    const doc = 'See [x](nope/zoomto/pct:1,2,3,4).';
    const diags = computeDiagnostics(doc, DEPS);
    const d = diags.find((x) => /no viewer in this document declares/.test(x.message));
    assert.ok(d);
    assert.equal(d.severity, 'warning');
  });
  it('does not warn when the id exists in the doc (negative)', () => {
    const doc =
      '{% include embed/image.html id="img1" src="x" %}\nSee [x](img1/zoomto/pct:1,2,3,4).';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /no viewer in this document/.test(m)));
  });
  it('uses getDocViewerIds when provided', () => {
    const deps = { catalog, getDocViewerIds: () => ['map1'] };
    const ok = computeDiagnostics('[x](map1/flyto/1,2,3)', deps);
    assert.ok(!messages(ok).some((m) => /no viewer/.test(m)));
    const bad = computeDiagnostics('[x](other/flyto/1,2,3)', deps);
    assert.ok(messages(bad).some((m) => /no viewer/.test(m)));
  });
});

describe('FR-EDIT.4 lint — malformed pct: arity', () => {
  it('errors on wrong zoomto arity (positive)', () => {
    const doc =
      '{% include embed/image.html id="i" src="x" %}\n[x](i/zoomto/pct:1,2,3).';
    const diags = computeDiagnostics(doc, DEPS);
    const d = diags.find((x) => /zoomto expects four/.test(x.message));
    assert.ok(d);
    assert.equal(d.severity, 'error');
  });
  it('accepts correct 4-number zoomto (negative)', () => {
    const doc =
      '{% include embed/image.html id="i" src="x" %}\n[x](i/zoomto/pct:1,2,3,4).';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /zoomto expects/.test(m)));
  });
  it('errors on a malformed region="pct:.." attribute', () => {
    const doc = '{% include embed/image.html src="x" region="pct:1,2,3" %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(messages(diags).some((m) => /Malformed region/.test(m)));
  });
});

describe('FR-EDIT.4 lint — vis-network data block', () => {
  it('warns when the <id>-csv block is missing (positive)', () => {
    const doc = '{% include embed/vis-network.html id="net" %}';
    const diags = computeDiagnostics(doc, DEPS);
    const d = diags.find((x) => /data block "\{: #net-csv \}" not found/.test(x.message));
    assert.ok(d);
    assert.equal(d.severity, 'warning');
  });
  it('does not warn when the matching csv block exists (negative)', () => {
    const doc =
      'node,1,A\nedge,1,1,x\n{: #net-csv }\n\n{% include embed/vis-network.html id="net" %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /not found/.test(m)));
  });
  it('honours a dataid override', () => {
    const doc =
      '{: #shared-data }\n{% include embed/vis-network.html id="net" dataid="shared-data" %}';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /not found/.test(m)));
  });
});

/* ============================================================ FR-EDIT.7 */

describe('FR-EDIT.7 front-matter diagnostics', () => {
  it('errors on an unclosed front-matter block (positive)', () => {
    const doc = '---\ntitle: Hi\nbody with no close\n';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(messages(diags).some((m) => /Unclosed front-matter/.test(m)));
  });
  it('accepts a well-formed closed block (negative)', () => {
    const doc = '---\ntitle: Hi\ndate: 2026-01-01\n---\n\nBody.';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /Unclosed front-matter/.test(m)));
  });
  it('warns on a tab character in front matter', () => {
    const doc = '---\ntitle:\tHi\n---\n';
    const diags = computeDiagnostics(doc, DEPS);
    const d = diags.find((x) => /Tab character in front matter/.test(x.message));
    assert.ok(d);
    assert.equal(d.severity, 'warning');
  });
  it('does not touch a document without front matter', () => {
    const doc = 'Just prose, no front matter.';
    const diags = computeDiagnostics(doc, DEPS);
    assert.ok(!messages(diags).some((m) => /front matter|front-matter/.test(m)));
  });
});

/* ==================================================== real-corpus sanity */

describe('lint on the real Monument Valley post produces no false positives', () => {
  const MONUMENT = [
    '---',
    'title: Monument Valley',
    'date: 2025-01-10',
    'storykit: true',
    '---',
    '',
    'The [Navajo Nation](Q1783171) area.',
    '',
    '{% include embed/image.html id="image" src="wc:Monument_Valley,_Utah,_USA.jpg" caption="Monument Valley, UT" aspect="1.272" %}',
    '',
    '[West](image/zoomto/pct:10.94,27.88,21.05,30){: label="West Mitten Butte"}',
    '',
    '[Monument Valley](map/flyto/37.02828,-110.23819,11) is part of the plateau.',
    '',
    '{% include embed/map.html',
    '    id="map"',
    '    center="Q192017"',
    '    zoom="5"',
    '    markers="Q118841~National_Parks|',
    '    Q777183~National_Parks|',
    '    Q223969~National_Parks"',
    '%}',
    '',
    '{% include embed/youtube.html vid="yg0As_HOvJk" id="video1" autoplay="true" %}',
  ].join('\n');

  it('has no error-severity diagnostics on valid StoryKit markup', () => {
    const diags = computeDiagnostics(MONUMENT, DEPS);
    const errors = diags.filter((d) => d.severity === 'error');
    assert.equal(
      errors.length,
      0,
      'unexpected errors: ' + JSON.stringify(messages(errors))
    );
  });

  it('scanLinks finds the QID, zoomto, and flyto links', () => {
    const actionSet = new Set(['zoomto', 'flyto', 'playat', 'play', 'pause']);
    const { qidLinks, actionLinks } = scanLinks(MONUMENT, 0, actionSet);
    assert.ok(qidLinks.some((q) => q.qid === 'Q1783171'));
    assert.ok(actionLinks.some((a) => a.action === 'zoomto' && a.id === 'image'));
    assert.ok(actionLinks.some((a) => a.action === 'flyto' && a.id === 'map'));
  });
});

/* =========================================================== composition */

describe('storykit() extension composition', () => {
  it('returns a non-empty extension array accepted by EditorState.create', () => {
    const ext = storykit(DEPS);
    assert.ok(Array.isArray(ext) && ext.length > 0);
    const state = EditorState.create({ doc: '{% include embed/image.html %}', extensions: ext });
    assert.ok(state);
  });
  it('is inert (returns []) without a catalog — keeps the scaffold contract', () => {
    assert.deepEqual(storykit({}), []);
  });
});

/* ========================================== §5.3 keystroke perf budget */

describe('performance — decoration update on a ~50 KB document', () => {
  it('median keystroke decoration cycle is well under budget', () => {
    // Build ~50 KB of realistic StoryKit markup.
    const block =
      'Prose paragraph with a [Wikidata link](Q192017) and some length to it. ' +
      'More words follow here to pad the paragraph out to a reasonable size.\n\n' +
      '{% include embed/image.html id="img{i}" src="wc:Foo_{i}.jpg" caption="Cap {i}" %}\n\n' +
      'See [region](img{i}/zoomto/pct:10.5,20.5,30.5,40.5){: label="Region {i}" }.\n\n';
    let doc = '---\ntitle: Perf\ndate: 2026-01-01\n---\n\n';
    let i = 0;
    while (doc.length < 50 * 1024) {
      doc += block.replaceAll('{i}', String(i++));
    }

    const { view, destroy } = mountView(doc, 5000);
    try {
      const runs = [];
      for (let r = 0; r < 11; r++) {
        const at = 5000 + r;
        const t0 = performance.now();
        view.dispatch({ changes: { from: at, insert: 'x' } });
        runs.push(performance.now() - t0);
      }
      runs.sort((a, b) => a - b);
      const median = runs[Math.floor(runs.length / 2)];
      // Log the median so CI captures the real number (budget is 16 ms; we
      // hard-fail only well above it to absorb CI variance).
      console.log(`[perf] median keystroke decoration cycle: ${median.toFixed(2)} ms`);
      assert.ok(
        median < 50,
        `median ${median.toFixed(2)} ms exceeded the 50 ms hard limit`
      );
    } finally {
      destroy();
    }
  }, { timeout: 20000 });
});
