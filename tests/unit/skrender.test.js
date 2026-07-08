// skrender.js needs classic-script globals (liquidjs/markdownit/jsyaml)
// BEFORE import — the harness loads them below via loadClassicLibs().
// Served from the repo's committed CDN fixtures (tests/render/fixtures/cdn)
// so this suite stays hermetic — same files the render harness pins.
const CLASSIC_LIBS = [
  '/tests/render/fixtures/cdn/npm/liquidjs@10.27.1/dist/liquid.browser.min.js',
  '/tests/render/fixtures/cdn/npm/markdown-it@14.3.0/dist/markdown-it.min.js',
  '/tests/render/fixtures/cdn/npm/markdown-it-footnote@3.0.3/dist/markdown-it-footnote.min.js',
  '/tests/render/fixtures/cdn/npm/markdown-it-sub@1.0.0/dist/markdown-it-sub.min.js',
  '/tests/render/fixtures/cdn/npm/markdown-it-sup@1.0.0/dist/markdown-it-sup.min.js',
  '/tests/render/fixtures/cdn/npm/js-yaml@4.3.0/dist/js-yaml.min.js',
];
async function loadClassicLibs() {
  if (window.liquidjs && window.markdownit && window.jsyaml) return;
  for (const src of CLASSIC_LIBS) {
    await new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = src; el.onload = res; el.onerror = rej;
      document.head.append(el);
    });
  }
}


describe('skrender: frameworkAssetOrigin rewrite (central editor policy)', () => {
  it('rewrites components/storykit js/css to the canonical; leaves media alone', async () => {
    await loadClassicLibs();
    if (typeof window.markdownit !== 'function') {
      throw new Error(`pre-import state: liquidjs=${typeof window.liquidjs} markdownit=${typeof window.markdownit} jsyaml=${typeof window.jsyaml}`);
    }
    const { renderPost } = await import('/assets/js/skrender.js');
    const context = {
      config: { url: 'https://user.github.io', baseurl: '/their-site', title: 'T' },
      assetOrigin: 'https://user.github.io',
      baseurl: '/their-site',
      frameworkAssetOrigin: 'https://rsnyder.github.io/storykit-starter',
      resolveFile: async (p) => {
        if (p === '_layouts/nolayout.html') return '{{ content }}';
        return null;
      },
      layouts: new Map(), includes: new Map(), locales: null,
    };
    const content = [
      '---', 'title: FW test', 'layout: nolayout', '---', '',
      '<iframe src="https://user.github.io/their-site/assets/components/image.html?src=x"></iframe>',
      '<script src="https://user.github.io/their-site/assets/js/storykit.js"></script>',
      '<link href="https://user.github.io/their-site/assets/css/storykit.css">',
      '<img src="https://user.github.io/their-site/assets/posts/pic.jpg">',
    ].join('\n');
    const { html } = await renderPost({ content, path: '_posts/2026-07-08-fw.md', context });
    assert.ok(html.includes('https://rsnyder.github.io/storykit-starter/assets/components/image.html'),
      'component iframe rewritten to canonical');
    assert.ok(html.includes('https://rsnyder.github.io/storykit-starter/assets/js/storykit.js'),
      'host runtime rewritten');
    assert.ok(html.includes('https://rsnyder.github.io/storykit-starter/assets/css/storykit.css'),
      'storykit.css rewritten');
    assert.ok(html.includes('https://user.github.io/their-site/assets/posts/pic.jpg'),
      'site media NOT rewritten');
    assert.ok(!html.includes('their-site/assets/components/'), 'no bound-site component refs remain');
  });

  it('no-ops when frameworkAssetOrigin equals the bound base or is unset', async () => {
    await loadClassicLibs();
    if (typeof window.markdownit !== 'function') {
      throw new Error(`pre-import state: liquidjs=${typeof window.liquidjs} markdownit=${typeof window.markdownit} jsyaml=${typeof window.jsyaml}`);
    }
    const { renderPost } = await import('/assets/js/skrender.js');
    const mk = (fw) => ({
      config: { url: 'https://rsnyder.github.io', baseurl: '/storykit-starter', title: 'T' },
      assetOrigin: 'https://rsnyder.github.io', baseurl: '/storykit-starter',
      ...(fw ? { frameworkAssetOrigin: fw } : {}),
      resolveFile: async (p) => (p === '_layouts/nolayout.html' ? '{{ content }}' : null),
      layouts: new Map(), includes: new Map(), locales: null,
    });
    const content = '---\ntitle: N\nlayout: nolayout\n---\n\n<iframe src="https://rsnyder.github.io/storykit-starter/assets/components/map.html"></iframe>\n';
    const a = await renderPost({ content, path: '_posts/2026-07-08-n.md', context: mk('https://rsnyder.github.io/storykit-starter') });
    const b = await renderPost({ content, path: '_posts/2026-07-08-n.md', context: mk(null) });
    assert.equal(a.html, b.html, 'same-base rewrite is byte-identical to unset');
  });
});

describe('skrender: wc: URLs with non-ASCII filenames (UTF-8 md5)', () => {
  it('hashes UTF-8 bytes like MediaWiki/Ruby (März → /a/a7/), not UTF-16 units', async () => {
    await loadClassicLibs();
    const { renderPost } = await import('/assets/js/skrender.js');
    const context = {
      config: { url: 'https://user.github.io', baseurl: '/site', title: 'T' },
      assetOrigin: 'https://user.github.io', baseurl: '/site',
      resolveFile: async (p) => (p === '_layouts/nolayout.html' ? '{{ content }}' : null),
      layouts: new Map(), includes: new Map(), locales: null,
    };
    const content = '---\ntitle: U\nlayout: nolayout\n---\n\n' +
      '![Geigersberg](wc:Sachsenheim_-_Ochsenbach_-_Geigersberg_-_nördlicher_Teil_von_SSO_im_März.jpg)\n';
    const { html } = await renderPost({ content, path: '_posts/2026-07-08-u.md', context });
    assert.ok(html.includes('/thumb/a/a7/'),
      `expected the UTF-8 md5 path segment /a/a7/ in: ${html.slice(html.indexOf('thumb'), html.indexOf('thumb') + 60)}`);
    assert.ok(!html.includes('/thumb/5/52/'), 'the mangled UTF-16 hash must be gone');
  });
});

describe('skrender: absolute media_subpath (external asset host)', () => {
  it('header and body images resolve to the external host, untouched by rawBase', async () => {
    await loadClassicLibs();
    const { renderPost } = await import('/assets/js/skrender.js');
    const context = {
      config: { url: 'https://user.github.io', baseurl: '/site', title: 'T' },
      assetOrigin: 'https://user.github.io', baseurl: '/site',
      rawContentBase: 'https://raw.githubusercontent.com/o/r/main/',
      resolveFile: async (p) => (p === '_layouts/nolayout.html' ? '{{ content }}' : null),
      layouts: new Map(), includes: new Map(), locales: null,
    };
    const content = [
      '---', 'title: Turmeric', 'layout: nolayout',
      'media_subpath: https://lab.plant-humanities.org/assets/posts/turmeric', '---', '',
      '![banner](banner.jpg)',
    ].join('\n');
    const { html } = await renderPost({ content, path: '_posts/2026-07-08-turmeric.md', context });
    assert.ok(html.includes('https://lab.plant-humanities.org/assets/posts/turmeric/banner.jpg'),
      'media_subpath + relative image → external absolute URL');
    assert.ok(!html.includes('raw.githubusercontent.com/o/r/main/_posts/https'),
      'no rawBase glued onto an absolute URL');
  });
});
