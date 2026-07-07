"""M4 media & entities e2e (WP-4.3) — spec §9 M4 criteria:

    "Each documented URL shape drops to a correct tag; entity search
     resolves 'Charles Darwin' → Q1035 in ≤ 3 interactions."

Reuses tools/render_regression.py's route-interception helpers and the
_hermetic_page/_boot_editor idioms established by tests/e2e/test_m3_preview.py
(sys.path.insert(0, tools); import render_regression as rr).

── Drop-simulation approach (documented per the WP-4.3 brief) ───────────────
Real cross-origin OS drag-and-drop can't be automated in Playwright (risk
R-7, already noted in editor/dnd.js and tests/unit/dnd.test.js). Rather than
fighting synthetic `DataTransfer` + coordinate `dragover`/`drop` dispatch
(flaky: depends on exact CM6 layout metrics for `posAtCoords`), these tests
drive the **paste** path instead: a synthetic `ClipboardEvent('paste', ...)`
dispatched at the editor's content DOM (the same technique
tests/e2e/test_m2_persistence.py's `_paste` helper already uses), followed by
a real click on the "Paste as StoryKit tag?" affordance button. This
exercises the *exact same* `parseDropPayload` grammar (editor/url-grammars.js)
and the *same* tag-insertion code paths dnd.js's drop handler uses for block
tags (`BLOCK_TAG_KINDS`) — the only difference is *placement* (paste replaces
the pasted range in-place; drop wraps the tag in blank lines via
`computeBlockInsertion`), which is unit-tested exhaustively in
tests/unit/dnd.test.js and is not what this milestone criterion is about
("drops to a correct tag" — the grammar + insertion correctness). Because
each test below starts from an EMPTY document and pastes at position 0, the
resulting buffer content is the literal tag string with no other characters
to account for, making the "exact inserted tag text" assertion unambiguous.

── Wikidata mocking ──────────────────────────────────────────────────────────
`www.wikidata.org/w/api.php` is intercepted with `page.route()`, branching on
the `action` query parameter (`wbsearchentities` / `wbgetentities`), returning
canned JSON. The route is registered AFTER install_editor_extra_routes (LIFO
route matching — see render_regression.py's `install_editor_extra_routes`
docstring) so it is checked before the hermetic catch-all abort.
"""

import json
import sys
import urllib.parse
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import render_regression as rr  # noqa: E402

from conftest import _cached_chromium  # noqa: E402

MOUNT_TIMEOUT = 25_000  # ms — CM editor mounted after a doc is opened


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def site_dir():
    """A built _site (the harness serves the editor page from it)."""
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


def _hermetic_page(browser):
    """A fresh context/page with the harness's route interception.

    Deliberately does NOT call `page.clock.set_fixed_time()` (unlike
    test_m3_preview.py's `_hermetic_page`, which needs a frozen Date for its
    byte-identical golden compare): CodeMirror 6's `hoverTooltip` (used by
    editor/wikidata.js's `qidHoverExtension`) detects a quiet hover period by
    comparing `Date.now()` at the last `mousemove` against `Date.now()` at
    check time — verified empirically, freezing Date makes that delta always
    read 0 and the hover card never appears, no matter how long the test
    waits. None of the M4 assertions depend on a deterministic wall clock, so
    the simplest fix is to leave real time running.
    """
    context = browser.new_context(locale="en-US", timezone_id="UTC")
    page = context.new_page()
    audit = rr.RouteAudit(False)
    rr.install_routes(page, audit)
    rr.install_editor_extra_routes(page, audit)
    return context, page, audit


def _boot_editor(page, base_url):
    page.goto(f"{base_url}/editor/index.html", wait_until="load",
              timeout=rr.POLL_TIMEOUT_MS)
    page.wait_for_selector("#new-doc:not([disabled])", timeout=rr.POLL_TIMEOUT_MS)


# ── Wikidata canned responses ─────────────────────────────────────────────────

DARWIN_SEARCH_RESPONSE = {
    "searchinfo": {"search": "Charles Darwin"},
    "search": [
        {"id": "Q1035", "label": "Charles Darwin",
         "description": "English naturalist and biologist (1809-1882)"},
        {"id": "Q47138461", "label": "Charles Darwin",
         "description": "disambiguation page"},
    ],
    "success": 1,
}

DARWIN_ENTITIES_RESPONSE = {
    "entities": {
        "Q1035": {
            "id": "Q1035",
            "labels": {"en": {"language": "en", "value": "Charles Darwin"}},
            "descriptions": {"en": {"language": "en",
                                     "value": "English naturalist and biologist (1809-1882)"}},
            "claims": {},
        },
    },
    "success": 1,
}


def _install_wikidata_mock(page, offline=False):
    """Registers AFTER install_editor_extra_routes (called inside
    _hermetic_page, which runs before this) so Playwright's LIFO route
    matching checks this route before the hermetic catch-all abort."""

    def handler(route):
        if offline:
            route.abort()
            return
        parsed = urllib.parse.urlparse(route.request.url)
        qs = urllib.parse.parse_qs(parsed.query)
        action = (qs.get("action") or [""])[0]
        if action == "wbsearchentities":
            route.fulfill(status=200, content_type="application/json; charset=utf-8",
                          body=json.dumps(DARWIN_SEARCH_RESPONSE))
        elif action == "wbgetentities":
            route.fulfill(status=200, content_type="application/json; charset=utf-8",
                          body=json.dumps(DARWIN_ENTITIES_RESPONSE))
        else:
            route.fulfill(status=404, content_type="application/json; charset=utf-8", body="{}")

    page.route("https://www.wikidata.org/**", handler)


# ── editor-driving helpers ────────────────────────────────────────────────────

def _new_empty_doc(page, title):
    page.evaluate(
        """async ({ title }) => {
            const app = await import('/editor/app.js');
            const rec = await app.modules.store.docs.create({ title, path: null, content: '' });
            await app.openDoc(rec.id);
            app.setMode('edit');
        }""",
        {"title": title},
    )
    page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)
    page.locator(".cm-content").click()


def _paste(page, text):
    """Synthetic paste at the cursor (same technique as
    tests/e2e/test_m2_persistence.py's `_paste` helper) — CM6's own
    domEventHandlers.paste (dnd.js) reads event.clipboardData directly, so
    this is indistinguishable from a real OS paste as far as the handler
    under test is concerned."""
    page.evaluate(
        """(text) => {
            const cm = document.querySelector('.cm-content');
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            cm.dispatchEvent(new ClipboardEvent('paste',
                { clipboardData: dt, bubbles: true, cancelable: true }));
        }""",
        text,
    )


def _buffer_text(page):
    """The CM6 document's actual text content — via `EditorView.findFromDOM`
    — rather than `.cm-content`'s rendered innerText, which also picks up
    the FR-DND.5 "Tag inserted · Add caption · Add id" hint widget's text
    (a block WidgetType decoration, not part of the document)."""
    return page.evaluate(
        """async () => {
            const { EditorView } = await import('@codemirror/view');
            const dom = document.querySelector('#editor-mount');
            const view = EditorView.findFromDOM(dom);
            return view ? view.state.doc.toString() : null;
        }"""
    )


# ── 1. drop/paste insertion per documented URL shape (FR-DND.2-4/6/7) ────────

def test_paste_commons_file_page_inserts_image_tag(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _new_empty_doc(page, "Commons drop")
            _paste(page, "https://commons.wikimedia.org/wiki/File:Example.jpg")
            page.wait_for_selector(".sk-dnd-paste-btn", timeout=5000)
            page.click(".sk-dnd-paste-btn")
            assert _buffer_text(page).strip() == \
                '{% include embed/image.html src="wc:Example.jpg" %}'
        finally:
            context.close()


def test_paste_youtube_watch_url_with_t_inserts_video_tag(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _new_empty_doc(page, "YouTube drop")
            _paste(page, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90")
            page.wait_for_selector(".sk-dnd-paste-btn", timeout=5000)
            page.click(".sk-dnd-paste-btn")
            assert _buffer_text(page).strip() == \
                '{% include embed/youtube.html vid="dQw4w9WgXcQ" start="90" %}'
        finally:
            context.close()


def test_paste_google_maps_at_url_inserts_map_tag(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _new_empty_doc(page, "Maps drop")
            _paste(page, "https://www.google.com/maps/@36.98,-110.2,12.3z")
            page.wait_for_selector(".sk-dnd-paste-btn", timeout=5000)
            page.click(".sk-dnd-paste-btn")
            assert _buffer_text(page).strip() == \
                '{% include embed/map.html center="36.98, -110.2" zoom="12.3" %}'
        finally:
            context.close()


def test_paste_maps_short_link_degrades_with_toast_and_no_tag(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _new_empty_doc(page, "Maps short link")
            _paste(page, "https://maps.app.goo.gl/AbCd1234")
            # Degrades to a warning toast; the raw URL text still lands
            # (normal, un-intercepted paste — FR-DND.6 "never silently
            # discarded"), but NO map tag is synthesized from an
            # unexpandable short link.
            toast = page.locator(".sk-toast-warning")
            toast.wait_for(state="visible", timeout=5000)
            assert "maps.app.goo.gl" in toast.inner_text()
            assert page.locator(".sk-dnd-paste-btn").count() == 0, \
                "no StoryKit-tag affordance should appear for an unresolvable short link"
            assert "{% include embed/map.html" not in _buffer_text(page)
            assert "maps.app.goo.gl/AbCd1234" in _buffer_text(page)
        finally:
            context.close()


def test_paste_arbitrary_url_inserts_markdown_link(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _new_empty_doc(page, "Arbitrary link")
            _paste(page, "https://example.com/some-page")
            page.wait_for_selector(".sk-dnd-paste-btn", timeout=5000)
            page.click(".sk-dnd-paste-btn")
            assert _buffer_text(page).strip() == "[example.com](https://example.com/some-page)"
        finally:
            context.close()


def test_paste_non_url_text_offers_no_affordance(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _new_empty_doc(page, "Plain prose paste")
            _paste(page, "just some regular prose, no link here")
            page.wait_for_timeout(400)  # let any (absent) affordance settle
            assert page.locator(".sk-dnd-paste-btn").count() == 0
            assert "just some regular prose" in _buffer_text(page)
        finally:
            context.close()


# ── 2. entity flow: mocked Wikidata search → insert (FR-WD.1/2) ─────────────

def test_link_entity_darwin_resolves_to_q1035_in_at_most_3_interactions(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _install_wikidata_mock(page)
            _boot_editor(page, base_url)

            # "Charles Darwin" occupies exactly the first 14 characters.
            _new_empty_doc(page, "Darwin entity")
            page.keyboard.type("Charles Darwin was a naturalist.")
            page.keyboard.press("ControlOrMeta+Home")
            page.keyboard.down("Shift")
            for _ in range(len("Charles Darwin")):
                page.keyboard.press("ArrowRight")
            page.keyboard.up("Shift")

            interactions = 0

            # Interaction 1: invoke the Link Entity command (⌘⇧K).
            page.keyboard.press("ControlOrMeta+Shift+KeyK")
            interactions += 1

            popup = page.locator(".sk-wd-popup")
            popup.wait_for(state="visible", timeout=5000)
            assert page.locator(".sk-wd-input").input_value() == "Charles Darwin"

            # Wait for the debounced (>=300ms), mocked search to resolve.
            first_result = page.locator(".sk-wd-result").first
            first_result.wait_for(state="visible", timeout=5000)
            assert first_result.get_attribute("data-qid") == "Q1035", \
                "Q1035 must be the top match so no arrow-key interaction is needed"
            assert "is-active" in (first_result.get_attribute("class") or "")

            # No arrow-key interaction needed: Q1035 is already active/first.

            # Interaction 2: accept with Enter.
            page.keyboard.press("Enter")
            interactions += 1

            assert popup.count() == 0, "popup should close after selection"
            assert interactions <= 3, f"used {interactions} interactions (budget: <=3)"
            print(f"\nDarwin entity-link flow used {interactions} interaction(s) "
                  f"(command + Enter; no arrow needed — Q1035 was the top match)")

            assert "[Charles Darwin](Q1035)" in _buffer_text(page)
        finally:
            context.close()


# ── 3. hover card (FR-WD.3) — entity pre-seeded via the store ───────────────

def test_hover_qid_link_shows_entity_card(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _install_wikidata_mock(page)
            _boot_editor(page, base_url)

            # Pre-seed entityCache (30-day TTL store, editor/store.js) so the
            # hover card can render even without relying on a prior search —
            # per the WP-4.3 brief's "or pre-seeded via the store" option.
            page.evaluate(
                """async () => {
                    const app = await import('/editor/app.js');
                    await app.modules.store.entityCache.put('Q1035', {
                        label: 'Charles Darwin',
                        description: 'English naturalist and biologist (1809-1882)',
                        wikidataUrl: 'https://www.wikidata.org/wiki/Q1035',
                    });
                }"""
            )

            page.evaluate(
                """async () => {
                    const app = await import('/editor/app.js');
                    const rec = await app.modules.store.docs.create({
                        title: 'Hover card doc', path: null,
                        content: 'See [Charles Darwin](Q1035) for more.',
                    });
                    await app.openDoc(rec.id);
                    app.setMode('edit');
                }"""
            )
            page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)

            link = page.locator(".sk-qid-link")
            link.wait_for(state="visible", timeout=5000)
            link.hover()

            card = page.locator(".sk-wd-hover-card")
            card.wait_for(state="visible", timeout=5000)
            page.wait_for_selector(".sk-wd-hover-label", timeout=5000)
            assert "Charles Darwin" in card.inner_text()
        finally:
            context.close()


# ── 4. offline degradation (FR-WD.4) ─────────────────────────────────────────

def test_offline_wikidata_shows_notice_and_manual_qid_still_inserts(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _install_wikidata_mock(page, offline=True)
            _boot_editor(page, base_url)

            _new_empty_doc(page, "Offline entity")
            page.keyboard.press("ControlOrMeta+Shift+KeyK")

            popup = page.locator(".sk-wd-popup")
            popup.wait_for(state="visible", timeout=5000)

            page.locator(".sk-wd-input").fill("Q42")

            notice = page.locator(".sk-wd-notice")
            notice.wait_for(state="visible", timeout=5000)
            assert "offline" in notice.inner_text().lower() or \
                "unavailable" in notice.inner_text().lower()

            manual = page.locator(".sk-wd-result.is-manual")
            manual.wait_for(state="visible", timeout=5000)
            assert "Q42" in manual.inner_text()

            page.keyboard.press("Enter")
            assert popup.count() == 0

            assert "[Q42](Q42)" in _buffer_text(page)
        finally:
            context.close()
