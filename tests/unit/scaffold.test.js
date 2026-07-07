// tests/unit/scaffold.test.js  (WP-2.1)
//
// Smoke test for the editor scaffold: app.js's frozen surface (bus/appState,
// docs/editor-plan.md §1.2), the single-instance CM6 assertion (risk R-3),
// and the importability + contracted export names of every stub module.
//
// app.js auto-boot is gated on #editor-mount, which this harness page does
// not have; __SK_NO_AUTOBOOT is set anyway as a belt-and-braces guard.
window.__SK_NO_AUTOBOOT = true;

import { describe, it, assert } from './runner.js';

const app = await import('../../editor/app.js');

describe('scaffold: app.js frozen surface (§1.2)', () => {
  it('exports bus as an EventTarget', () => {
    assert.ok(app.bus instanceof EventTarget, 'bus must be an EventTarget');
  });

  it('bus delivers CustomEvents with detail', async () => {
    const got = await new Promise((resolve) => {
      app.bus.addEventListener('toast', (e) => resolve(e.detail), { once: true });
      app.bus.dispatchEvent(new CustomEvent('toast', { detail: { message: 'hi' } }));
    });
    assert.deepEqual(got, { message: 'hi' });
  });

  it('exports appState with the contracted keys', () => {
    assert.ok(app.appState && typeof app.appState === 'object');
    for (const key of ['currentDocId', 'mode', 'binding', 'prefs']) {
      assert.ok(key in app.appState, `appState.${key} missing`);
    }
  });

  it('appState.mode is a valid editor mode', () => {
    assert.ok(['edit', 'split', 'preview'].includes(app.appState.mode),
      `unexpected mode: ${app.appState.mode}`);
  });

  it('appState.prefs has theme/mode/sidebarCollapsed/lastDocId', () => {
    for (const key of ['theme', 'mode', 'sidebarCollapsed', 'lastDocId']) {
      assert.ok(key in app.appState.prefs, `prefs.${key} missing`);
    }
  });

  it('single-instance assertion passes (risk R-3)', () => {
    const result = app.assertSingleInstance();
    assert.ok(result.ok, `assertSingleInstance failed: ${result.error?.message}`);
  });
});

// ---------------------------------------------------------------------------
// Stub modules: importable, contracted export names present with right types.
// Shapes per docs/editor-plan.md §1.2. 'function' includes classes.
// ---------------------------------------------------------------------------
const STUB_CONTRACTS = {
  '../../editor/store.js': {
    initStore: 'function',
    docs: { list: 'function', get: 'function', create: 'function', update: 'function', remove: 'function', duplicate: 'function' },
    revisions: { snapshot: 'function', list: 'function', get: 'function', prune: 'function' },
    repoCache: { get: 'function', put: 'function', makeKey: 'function' },
    entityCache: { get: 'function', put: 'function' },
    createAutosaver: 'function',
    requestPersistence: 'function',
  },
  '../../editor/editor.js': { createEditor: 'function' },
  '../../editor/commands.js': { editorKeymap: 'object', toggleBold: 'function', toggleItalic: 'function', insertLink: 'function', cycleHeading: 'function' },
  '../../editor/lang-storykit.js': { storykit: 'function' },
  '../../editor/doclist.js': { createDocList: 'function' },
  '../../editor/preview.js': { createPreviewPane: 'function' },
  '../../editor/statusbar.js': { createStatusBar: 'function' },
  '../../editor/github.js': {
    getToken: 'function', setToken: 'function', forgetToken: 'function',
    getFile: 'function', putFile: 'function', getRepo: 'function',
    listBranches: 'function', getBranchHead: 'function', createBranch: 'function',
    GitHubError: 'function',
  },
  '../../editor/context.js': { buildContext: 'function' },
  '../../editor/wikidata.js': { searchEntities: 'function', getEntities: 'function', linkEntityCommand: 'function', qidHoverExtension: 'function' },
  '../../editor/dnd.js': { dndExtension: 'function' },
  '../../editor/sync.js': { commitDocument: 'function', pullDocument: 'function', bindDocument: 'function' },
  '../../editor/conflict.js': { resolveConflict: 'function' },
};

describe('scaffold: stub modules importable with contracted exports', () => {
  for (const [path, contract] of Object.entries(STUB_CONTRACTS)) {
    const name = path.replace('../../', '');
    it(`${name} exports match the contract`, async () => {
      const mod = await import(path);
      for (const [exp, shape] of Object.entries(contract)) {
        assert.ok(exp in mod, `${name}: missing export '${exp}'`);
        if (typeof shape === 'string') {
          assert.equal(typeof mod[exp], shape, `${name}: '${exp}' should be ${shape}, got ${typeof mod[exp]}`);
        } else {
          // Nested method contract (e.g. store.docs.list)
          assert.ok(mod[exp] && typeof mod[exp] === 'object', `${name}: '${exp}' should be an object`);
          for (const [method, type] of Object.entries(shape)) {
            assert.equal(typeof mod[exp][method], type,
              `${name}: '${exp}.${method}' should be ${type}, got ${typeof mod[exp][method]}`);
          }
        }
      }
    });
  }

  it('not-implemented stubs throw the WP-x.y marker', async () => {
    const store = await import('../../editor/store.js');
    await assert.rejects(() => store.initStore(), /WP-2\.2: not implemented/);
    const editor = await import('../../editor/editor.js');
    assert.throws(() => editor.createEditor({}), /WP-2\.3: not implemented/);
    const conflict = await import('../../editor/conflict.js');
    await assert.rejects(() => conflict.resolveConflict({ local: 'a', remote: 'b' }), /WP-5\.2: not implemented/);
  });

  it('inert-default stubs return composable values', async () => {
    const langStorykit = await import('../../editor/lang-storykit.js');
    assert.deepEqual(langStorykit.storykit({}), [], 'storykit() should return an inert []');
    const dnd = await import('../../editor/dnd.js');
    assert.deepEqual(dnd.dndExtension({}), [], 'dndExtension() should return an inert []');
    const wikidata = await import('../../editor/wikidata.js');
    assert.deepEqual(wikidata.qidHoverExtension(), [], 'qidHoverExtension() should return an inert []');
    assert.equal(wikidata.linkEntityCommand(null), false, 'linkEntityCommand stub should return false');
    const commands = await import('../../editor/commands.js');
    assert.ok(Array.isArray(commands.editorKeymap) && commands.editorKeymap.length === 0,
      'editorKeymap stub should be an empty array');
  });

  it('GitHubError carries status and kind', async () => {
    const { GitHubError } = await import('../../editor/github.js');
    const err = new GitHubError('rate limited', { status: 403, kind: 'rate-limit' });
    assert.ok(err instanceof Error);
    assert.equal(err.status, 403);
    assert.equal(err.kind, 'rate-limit');
  });

  it('viewer-catalog and url-grammars (merged deps) are reachable from the editor graph', async () => {
    const catalog = await import('../../editor/viewer-catalog.js');
    assert.ok(catalog.catalog && catalog.bundledIncludeList.length === 6);
    const grammars = await import('../../editor/url-grammars.js');
    assert.equal(typeof grammars.parseDropPayload, 'function');
  });
});
