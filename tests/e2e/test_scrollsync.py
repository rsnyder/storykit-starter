"""Split-view scroll sync (editor/scrollsync.js + app.js wiring).

Anchor-interpolated two-way sync: scrolling the source pane moves the
preview to the mapped position and vice versa; the palette-toggleable
pref turns it off. Uses a long document with headings so the map has
real anchors and both panes have room to scroll.
"""

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_regression as rr  # noqa: E402

from test_m5_sync import browser, site_dir, _hermetic_page  # noqa: E402,F401

DOC = "---\ntitle: Scrollsync probe\n---\n\n" + "\n\n".join(
    f"## Section {i}\n\n" + ("Lorem ipsum dolor sit amet, consectetur. " * 30)
    for i in range(14)
)


def _boot_split(page, base_url):
    page.goto(f"{base_url}/editor/index.html", wait_until="load",
              timeout=rr.POLL_TIMEOUT_MS)
    page.wait_for_selector("#new-doc:not([disabled])", timeout=rr.POLL_TIMEOUT_MS)
    page.evaluate(
        """async (c) => {
            const app = await import('/editor/app.js');
            const r = await app.modules.store.docs.create({
                title: 'S', path: '_posts/2026-07-09-s.md', content: c });
            await app.openDoc(r.id);
            app.setMode('split');
        }""", DOC)
    page.wait_for_selector(".cm-content", timeout=30_000)
    # map is rebuilt on the preview's load event; give the render time
    page.wait_for_function(
        """() => {
            const f = document.querySelector('#preview-mount iframe.pv-frame');
            return f && f.contentDocument
                && f.contentDocument.querySelectorAll('.post-content h2').length >= 10; }""",
        timeout=60_000)
    page.wait_for_timeout(1500)


def _preview_scroll_y(page):
    return page.evaluate(
        """() => document.querySelector('#preview-mount iframe.pv-frame')
                  .contentWindow.scrollY""")


def _editor_scroll_top(page):
    return page.evaluate(
        "() => document.querySelector('.cm-scroller').scrollTop")


def test_two_way_scroll_sync_in_split_view(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            page.set_viewport_size({"width": 1400, "height": 800})
            _boot_split(page, base_url)
            assert _preview_scroll_y(page) == 0

            # editor → preview
            page.evaluate(
                """() => { const s = document.querySelector('.cm-scroller');
                     s.scrollTo({ top: s.scrollHeight * 0.6 }); }""")
            page.wait_for_function(
                """() => document.querySelector('#preview-mount iframe.pv-frame')
                          .contentWindow.scrollY > 300""", timeout=10_000)
            pv_after = _preview_scroll_y(page)
            assert pv_after > 300, f"preview should follow editor (scrollY={pv_after})"

            # preview → editor (wait out the echo lock first)
            page.wait_for_timeout(400)
            ed_before = _editor_scroll_top(page)
            page.evaluate(
                """() => { const w = document.querySelector('#preview-mount iframe.pv-frame').contentWindow;
                     w.scrollTo({ top: 50 }); }""")
            page.wait_for_function(
                f"""() => document.querySelector('.cm-scroller').scrollTop < {ed_before - 100}""",
                timeout=10_000)
        finally:
            context.close()


def test_toggle_disables_sync(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            page.set_viewport_size({"width": 1400, "height": 800})
            _boot_split(page, base_url)
            page.evaluate(
                """async () => {
                    const app = await import('/editor/app.js');
                    app.appState.prefs.scrollSync = false;
                }""")
            page.evaluate(
                """() => { const s = document.querySelector('.cm-scroller');
                     s.scrollTo({ top: s.scrollHeight * 0.6 }); }""")
            page.wait_for_timeout(1200)
            assert _preview_scroll_y(page) == 0, "sync off → preview does not move"
        finally:
            context.close()
