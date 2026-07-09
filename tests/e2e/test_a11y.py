"""axe-core WCAG 2.1 AA audit of the editor surfaces (WP-6.3) — spec §5.4 /
§9 M6 criterion: "axe-core clean on AA".

Runs Deque's axe-core against six product surfaces:

  (a) the booted editor with a seeded doc + a populated document list (the
      colored `.dl-badge` states the WP-6.2 handoff flagged as possible AA
      contrast risks are deliberately materialised here);
  (b) the ⌘K command palette;
  (c) the sync panel (`<dialog id="sync-panel">`);
  (d) the conflict-resolution dialog (driven by a direct `resolveConflict()`
      module call — the same DOM the 409 path builds, without needing a full
      stale-sha round trip);
  (e) the Wikidata "Link entity" popup (Wikidata mocked, as in
      test_m4_media.py / test_m6_keyboard.py);
  (f) the 390 px mobile sidebar drawer.

axe is injected from a COMMITTED, VENDORED copy (tests/e2e/vendor/axe.min.js,
axe-core 4.10.2 — see docs/dependencies.md) — never fetched from a CDN at
test time, keeping the suite hermetic like every other e2e file here.

Scope: the preview iframe's inner document is Chirpy content, not this
product's surface, so it is excluded from every audit context
(`exclude: [['#preview-mount']]`). The audit runs `wcag2a` + `wcag2aa` rules
and asserts ZERO violations (serious/critical are the non-negotiable floor;
we hold the whole surface to zero). `incomplete` ("needs review") items are
surfaced in the test output for the record, not failed on.
"""

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import render_regression as rr  # noqa: E402

from conftest import _cached_chromium  # noqa: E402

MOUNT_TIMEOUT = 25_000  # ms

AXE_SOURCE = (REPO / "tests" / "e2e" / "vendor" / "axe.min.js").read_text(encoding="utf-8")

# axe context: audit everything EXCEPT the preview iframe subtree (Chirpy
# content, not this product's surface — see module docstring).
AXE_CONTEXT = {"exclude": [["#preview-mount"]]}
AXE_OPTIONS = {
    "runOnly": {"type": "tag", "values": ["wcag2a", "wcag2aa"]},
    # The srcdoc preview iframe is sandboxed and irrelevant; don't descend
    # into frames at all — every audited surface lives in the top frame.
    "iframes": False,
    "resultTypes": ["violations", "incomplete"],
}


# ── fixtures (mirror test_m6_keyboard.py) ───────────────────────────────────

@pytest.fixture(scope="session")
def site_dir():
    import subprocess

    site = rr.REPO_ROOT / "_site"
    if not (site / "editor" / "index.html").exists():
        subprocess.run(
            ["bundle", "exec", "jekyll", "build"], cwd=rr.REPO_ROOT, check=True,
            capture_output=True,
        )
    assert (site / "editor" / "index.html").exists(), "_site build produced no editor page"
    return site


@pytest.fixture(scope="session")
def browser(playwright):
    kwargs = {"headless": True}
    exe = _cached_chromium()
    try:
        b = playwright.chromium.launch(**kwargs)
    except Exception:
        if not exe:
            raise
        b = playwright.chromium.launch(executable_path=exe, **kwargs)
    yield b
    b.close()


def _hermetic_page(browser, **ctx_kwargs):
    context = browser.new_context(locale="en-US", timezone_id="UTC", **ctx_kwargs)
    page = context.new_page()
    audit = rr.RouteAudit(False)
    rr.install_routes(page, audit)
    rr.install_editor_extra_routes(page, audit)
    return context, page, audit


def _boot_editor(page, base_url):
    page.goto(f"{base_url}/editor/index.html", wait_until="load",
              timeout=rr.POLL_TIMEOUT_MS)
    page.wait_for_selector("#new-doc:not([disabled])", timeout=rr.POLL_TIMEOUT_MS)


def _seed_docs(page):
    """Create documents that exercise every doclist badge state (Local only,
    Synced, Local changes, Remote changed) so axe sees the coloured
    `.dl-badge` text the WP-6.2 handoff flagged. Then open one so the editor,
    toolbar, and status bar are all populated."""
    page.evaluate(
        """async () => {
            const app = await import('/editor/app.js');
            const { docs } = app.modules.store;
            const now = new Date().toISOString();
            const past = new Date(Date.now() - 3600_000).toISOString();

            const a = await docs.create({ title: 'Local-only draft', path: null, content: '# Draft\\n\\nProse.' });
            const b = await docs.create({ title: 'Synced post', path: '_posts/2026-07-06-synced.md', content: '# Synced' });
            await docs.update(b.id, { github: { owner: 'o', repo: 'r', branch: 'main', sha: 'abc', syncedAt: now } });
            const c = await docs.create({ title: 'Edited post', path: '_posts/2026-07-06-edited.md', content: '# Edited' });
            await docs.update(c.id, { content: '# Edited more', github: { owner: 'o', repo: 'r', branch: 'main', sha: 'abc', syncedAt: past } });
            const d = await docs.create({ title: 'Remote-changed post', path: '_posts/2026-07-06-remote.md', content: '# Remote' });
            await docs.update(d.id, { github: { owner: 'o', repo: 'r', branch: 'main', sha: 'abc', syncedAt: now, remoteChanged: true } });

            await app.openDoc(a.id);
            app.setMode('edit');
            // The doclist refreshes on doc:saved / sync:status bus events
            // (editor/doclist.js contract) — the direct docs.update() calls
            // above bypass the autosave path that normally emits them.
            app.bus.dispatchEvent(new CustomEvent('doc:saved', { detail: {} }));
        }"""
    )
    page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)
    # state="attached": on the 390 px viewport the sidebar drawer is closed
    # at this point, so the badge exists but is not visible yet.
    page.wait_for_selector(".dl-badge[data-status='remote-changed']",
                           state="attached", timeout=MOUNT_TIMEOUT)


def _run_axe(page, context=AXE_CONTEXT):
    """Inject the vendored axe and run it; returns a slimmed results object."""
    page.evaluate(AXE_SOURCE)
    return page.evaluate(
        """async ({ context, options }) => {
            const res = await window.axe.run(context, options);
            const slim = (arr) => arr.map(r => ({
                id: r.id, impact: r.impact, help: r.help,
                nodes: r.nodes.map(n => ({
                    target: n.target,
                    failureSummary: n.failureSummary,
                    html: (n.html || '').slice(0, 200),
                })),
            }));
            return {
                violations: slim(res.violations),
                incomplete: slim(res.incomplete),
                version: window.axe.version,
            };
        }""",
        {"context": context, "options": AXE_OPTIONS},
    )


def _assert_clean(results, surface):
    violations = results["violations"]
    serious = [v for v in violations if v["impact"] in ("serious", "critical")]

    def _fmt(vs):
        out = []
        for v in vs:
            targets = "; ".join(str(n["target"]) for n in v["nodes"][:5])
            summ = (v["nodes"][0]["failureSummary"] if v["nodes"] else "") or ""
            out.append(f"    [{v['impact']}] {v['id']}: {v['help']}\n      nodes: {targets}\n      {summ.splitlines()[0] if summ else ''}")
        return "\n".join(out)

    assert not serious, (
        f"{surface}: axe found {len(serious)} serious/critical AA violation(s) "
        f"(axe {results['version']}):\n{_fmt(serious)}"
    )
    assert not violations, (
        f"{surface}: axe found {len(violations)} AA violation(s) "
        f"(axe {results['version']}):\n{_fmt(violations)}"
    )
    if results["incomplete"]:
        ids = sorted({v["id"] for v in results["incomplete"]})
        print(f"[a11y] {surface}: {len(results['incomplete'])} needs-review item(s): {ids}")


# ── (a) booted editor + populated document list ─────────────────────────────

def test_axe_editor_booted_with_doclist(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _seed_docs(page)
            _assert_clean(_run_axe(page), "editor (booted + doclist)")
        finally:
            context.close()


# ── (b) command palette ─────────────────────────────────────────────────────

def test_axe_command_palette(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _seed_docs(page)
            page.keyboard.press("ControlOrMeta+KeyK")
            page.wait_for_selector(".sk-palette", timeout=5000)
            _assert_clean(_run_axe(page), "command palette")
        finally:
            context.close()


# ── (c) sync panel ──────────────────────────────────────────────────────────

def test_axe_sync_panel(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _seed_docs(page)
            page.keyboard.press("ControlOrMeta+KeyK")
            page.wait_for_selector(".sk-palette", timeout=5000)
            page.keyboard.type("sync panel")
            page.wait_for_selector('[data-sk-palette-id="sync.panel"].is-active', timeout=5000)
            page.keyboard.press("Enter")
            page.wait_for_selector("dialog#sync-panel[open]", timeout=5000)
            _assert_clean(_run_axe(page), "sync panel")
        finally:
            context.close()


# ── (d) conflict dialog (direct module call) ────────────────────────────────

def test_axe_conflict_dialog(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _seed_docs(page)
            page.evaluate(
                """async () => {
                    const app = await import('/editor/app.js');
                    app.modules.conflict.resolveConflict({
                        local: 'Line one\\nLocal line two\\nShared tail\\n',
                        remote: 'Line one\\nRemote line two\\nShared tail\\n',
                    });
                }"""
            )
            page.wait_for_selector(".sk-conflict-dialog", timeout=5000)
            page.click('[data-sk-conflict-action="diff"]')
            page.wait_for_selector(".sk-conflict-pane-local", timeout=5000)
            _assert_clean(_run_axe(page), "conflict dialog")
        finally:
            context.close()


# ── (e) Wikidata "Link entity" popup ────────────────────────────────────────

DARWIN_SEARCH = {
    "searchinfo": {"search": "Charles Darwin"},
    "search": [{"id": "Q1035", "label": "Charles Darwin",
                "description": "English naturalist and biologist (1809-1882)"}],
    "success": 1,
}
DARWIN_ENTITIES = {
    "entities": {"Q1035": {"id": "Q1035",
                           "labels": {"en": {"language": "en", "value": "Charles Darwin"}},
                           "descriptions": {"en": {"language": "en",
                                                    "value": "English naturalist and biologist (1809-1882)"}},
                           "claims": {}}},
    "success": 1,
}


def _install_wikidata_mock(page):
    import json
    import urllib.parse

    def handler(route):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(route.request.url).query)
        action = (qs.get("action") or [""])[0]
        if action == "wbsearchentities":
            body = json.dumps(DARWIN_SEARCH)
        elif action == "wbgetentities":
            body = json.dumps(DARWIN_ENTITIES)
        else:
            body = "{}"
        route.fulfill(status=200, content_type="application/json; charset=utf-8", body=body)

    page.route("https://www.wikidata.org/**", handler)


def test_axe_wikidata_popup(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _install_wikidata_mock(page)
            _boot_editor(page, base_url)
            _seed_docs(page)
            page.locator(".cm-content").focus()
            page.keyboard.type("Charles Darwin was a naturalist.")
            page.keyboard.press("ControlOrMeta+Home")
            page.keyboard.down("Shift")
            for _ in range(len("Charles Darwin")):
                page.keyboard.press("ArrowRight")
            page.keyboard.up("Shift")
            page.keyboard.press("ControlOrMeta+Shift+KeyK")
            page.wait_for_selector(".sk-wd-popup", timeout=5000)
            page.wait_for_selector(".sk-wd-result", timeout=5000)
            _assert_clean(_run_axe(page), "wikidata popup")
        finally:
            context.close()


# ── (f) 390 px mobile sidebar drawer ────────────────────────────────────────

def test_axe_mobile_drawer(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser, viewport={"width": 390, "height": 844})
        try:
            _boot_editor(page, base_url)
            _seed_docs(page)
            page.click("#sidebar-toggle")
            page.wait_for_function(
                "() => document.body.classList.contains('sidebar-open')", timeout=3000
            )
            # Let the drawer's 160 ms opacity transition finish — sampling
            # mid-transition makes axe compute contrast against blended,
            # semi-transparent colors (false positives).
            page.wait_for_timeout(400)
            _assert_clean(_run_axe(page), "mobile drawer (390px)")
        finally:
            context.close()


def test_axe_help_page(browser, site_dir):
    """The editor help page (editor/help.html) must meet the same AA bar."""
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            page.goto(f"{base_url}/editor/help.html", wait_until="load",
                      timeout=rr.POLL_TIMEOUT_MS)
            # sanity: the bookmarklet built itself for this deployment
            href = page.get_attribute("#bookmarklet-link", "href")
            assert href and href.startswith("javascript:") and "?open=" in href
            _assert_clean(_run_axe(page, context="body"), "help page")
        finally:
            context.close()
