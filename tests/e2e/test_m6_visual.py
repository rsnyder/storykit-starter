"""M6 visual-polish e2e (WP-6.2) — spec §5.4/§5.5 checklist:

    "consistent 8px spacing grid, one accent color, no layout shift on async
    loads (skeletons/placeholders), empty states with guidance, toasts for
    async outcomes ... Mobile: read and light editing must work (responsive
    layout, toolbar collapses)"

Four checks, one per docs/editor-plan.md WP-6.2 deliverable:

  (a) no-CLS on boot — a PerformanceObserver('layout-shift') is installed via
      `page.add_init_script` (so it's live before the very first paint, on
      EVERY navigation the page does — Playwright re-runs init scripts on
      each nav). A document is created, then the page is RELOADED so the
      second boot exercises the real "restore the last-open document" async
      path (store.initStore() -> doclist mount -> openDoc()) that WP-6.2's
      skeleton fix targets — the previous behaviour dropped the editor
      skeleton eagerly, before that restore even started, leaving a blank
      mount for the whole await chain.

  (b) toast stacking + the dismiss policy documented in editor/app.js's
      showToast()/editor/styles.css's toast section: success/warning/info
      auto-dismiss at a consistent interval; error toasts persist until
      manually closed. Three toasts fired at once must render as three
      visually distinct (non-overlapping, top-to-bottom) stacked elements.

  (c) 390px viewport — a real UI walkthrough (open the mobile sidebar
      drawer via the WP-6.2 overlay fix, create a post through the actual
      "+ New" form, type prose) with a `document.documentElement.scrollWidth
      <= innerWidth` assertion after every step, in both Edit and Preview
      modes.

  (d) prefers-reduced-motion — toast and command-palette transitions must
      compute to an effectively-instant duration (styles.css zeroes them
      under the media query; the palette has none to begin with, so "no
      transition property" is an equally valid pass).

Uses the same hermetic-routing / built-`_site` harness as
tests/e2e/test_m6_keyboard.py (esm.sh's live CDN is the one documented,
tracked exception — see render_regression.py's TARGETS section — every
other subresource is served from the local tree or a committed fixture).
"""

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import render_regression as rr  # noqa: E402

from conftest import _cached_chromium  # noqa: E402

MOUNT_TIMEOUT = 25_000  # ms


# ── fixtures (mirrors test_m6_keyboard.py) ──────────────────────────────────

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


def _new_context(browser, **kwargs):
    """A fresh context/page with the harness's hermetic route interception,
    optionally with extra `browser.new_context(...)` kwargs (viewport,
    reduced_motion, ...)."""
    context = browser.new_context(locale="en-US", timezone_id="UTC", **kwargs)
    page = context.new_page()
    audit = rr.RouteAudit(False)
    rr.install_routes(page, audit)
    rr.install_editor_extra_routes(page, audit)
    return context, page


def _boot_editor(page, base_url):
    page.goto(f"{base_url}/editor/index.html", wait_until="load",
              timeout=rr.POLL_TIMEOUT_MS)
    page.wait_for_selector("#new-doc:not([disabled])", timeout=rr.POLL_TIMEOUT_MS)


def _new_empty_doc(page, title):
    """Setup helper (not the behaviour under test) — same technique
    test_m6_keyboard.py's `_new_empty_doc` uses: create+open a document via
    the real store call, bypassing the UI, purely to get a document seeded/
    open for tests whose subject is something else."""
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


def _no_horizontal_scroll(page):
    return page.evaluate(
        "() => document.documentElement.scrollWidth <= window.innerWidth"
    )


# ── (a) no layout shift on the async boot / doc-restore path ───────────────

CLS_OBSERVER_SCRIPT = """
window.__cls = 0;
window.__clsSupported = true;
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput) window.__cls += entry.value;
    }
  }).observe({ type: 'layout-shift', buffered: true });
} catch (e) {
  window.__clsSupported = false;
}
"""


def test_no_layout_shift_on_boot_with_restored_doc(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page = _new_context(browser)
        try:
            # Installed before the FIRST navigation; Playwright re-runs init
            # scripts on every subsequent navigation of this page too, so the
            # reload below gets its own fresh (zeroed) `window.__cls`.
            page.add_init_script(CLS_OBSERVER_SCRIPT)

            _boot_editor(page, base_url)
            _new_empty_doc(page, "CLS probe post")
            # openDoc() persists lastDocId to localStorage (savePrefs) — the
            # reload's boot will restore THIS document, exercising the
            # store.initStore() -> doclist mount -> openDoc() async chain the
            # skeleton fix targets, instead of the boot-to-empty-state path.
            page.reload(wait_until="load", timeout=rr.POLL_TIMEOUT_MS)
            page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)
            # Let any trailing shifts (e.g. a slow-settling web font metric,
            # though styles.css deliberately avoids webfont fetches) resolve.
            page.wait_for_timeout(500)

            supported = page.evaluate("() => window.__clsSupported")
            assert supported, "PerformanceObserver layout-shift unsupported in this browser"
            cls = page.evaluate("() => window.__cls")
            assert cls < 0.1, f"cumulative layout shift {cls} exceeds the 0.1 budget"
        finally:
            context.close()


# ── (b) toast stacking + the documented dismiss policy ──────────────────────

def _fire_toasts(page, toasts):
    page.evaluate(
        """async (toasts) => {
            const app = await import('/editor/app.js');
            for (const t of toasts) {
                app.bus.dispatchEvent(new CustomEvent('toast', { detail: t }));
            }
        }""",
        toasts,
    )


def test_toast_stacking_and_dismiss_policy(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page = _new_context(browser)
        try:
            _boot_editor(page, base_url)

            _fire_toasts(page, [
                {"message": "First", "level": "success"},
                {"message": "Second", "level": "warning"},
                {"message": "Third — needs attention", "level": "error"},
            ])
            page.wait_for_selector(".sk-toast", timeout=5000)
            toasts = page.locator(".sk-toast")
            assert toasts.count() == 3, "all three toasts should stack, not replace each other"

            # Visually stacked: three distinct, ascending top offsets (a
            # flex-column region, newest appended last i.e. nearest the
            # bottom edge) — not overlapping at the same position.
            tops = [toasts.nth(i).bounding_box()["y"] for i in range(3)]
            assert len(set(tops)) == 3, f"toasts overlap instead of stacking: {tops}"
            assert tops == sorted(tops), f"toasts are not in visual stack order: {tops}"

            # Every toast carries a level icon + a manual close button.
            for i in range(3):
                one = toasts.nth(i)
                assert one.locator(".sk-toast-icon svg").count() == 1
                assert one.locator(".sk-toast-close").count() == 1

            # Dismiss policy: success/warning auto-dismiss; error persists.
            page.wait_for_function(
                "() => document.querySelectorAll('.sk-toast').length === 1",
                timeout=7000,
            )
            remaining = page.locator(".sk-toast")
            assert remaining.count() == 1
            cls_attr = remaining.first.get_attribute("class")
            assert "sk-toast-error" in cls_attr, (
                f"the surviving toast should be the error one, got: {cls_attr}"
            )

            # ...until the author closes it manually.
            remaining.first.locator(".sk-toast-close").click()
            page.wait_for_function(
                "() => document.querySelectorAll('.sk-toast').length === 0",
                timeout=2000,
            )
        finally:
            context.close()


# ── (c) 390px viewport — light editing must work ────────────────────────────

def test_narrow_viewport_no_horizontal_scroll_edit_and_preview(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page = _new_context(browser, viewport={"width": 390, "height": 844})
        try:
            _boot_editor(page, base_url)
            assert _no_horizontal_scroll(page), "horizontal scroll present right after boot"

            # The sidebar (home of "+ New") is an overlay drawer below 820px
            # (WP-6.2 fix — previously `#sidebar-toggle` only ever flipped
            # `sidebar-collapsed`, which the ≤820px media query ignores, so
            # the sidebar was permanently unreachable on mobile).
            page.click("#sidebar-toggle")
            page.wait_for_function(
                "() => document.body.classList.contains('sidebar-open')", timeout=3000
            )
            assert _no_horizontal_scroll(page), "horizontal scroll with the sidebar drawer open"

            page.click("#new-doc")
            page.wait_for_selector(".dl-new-input", timeout=5000)
            page.fill(".dl-new-input", "Mobile draft")
            page.click(".dl-new-form button[type=submit]")
            page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)

            # Opening a document closes the drawer again (WP-6.2) — editor
            # immediately usable, no leftover overlay eating the viewport.
            page.wait_for_function(
                "() => !document.body.classList.contains('sidebar-open')", timeout=3000
            )

            page.click(".cm-content")
            page.keyboard.type(
                "A reasonably long sentence of prose typed on a 390px-wide viewport "
                "to make sure the editor never forces the page to scroll sideways."
            )
            assert _no_horizontal_scroll(page), "horizontal scroll while typing in Edit mode"

            page.click('[data-mode-btn="preview"]')
            page.wait_for_function(
                "() => document.body.getAttribute('data-mode') === 'preview'", timeout=5000
            )
            # Give the preview pane's first render (library load + skrender
            # import) a moment; either the quiet loading overlay or the
            # rendered iframe is on screen the whole time — never blank.
            page.wait_for_timeout(300)
            assert _no_horizontal_scroll(page), "horizontal scroll in Preview mode"
        finally:
            context.close()


# ── (d) prefers-reduced-motion — transitions are effectively instant ───────

def test_reduced_motion_makes_toast_and_palette_transitions_instant(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page = _new_context(browser, reduced_motion="reduce")
        try:
            _boot_editor(page, base_url)

            _fire_toasts(page, [{"message": "Reduced motion check", "level": "success"}])
            page.wait_for_selector(".sk-toast", timeout=5000)
            toast_duration = page.eval_on_selector(
                ".sk-toast", "el => getComputedStyle(el).transitionDuration"
            )
            assert toast_duration in ("0s", ""), f"toast transition not instant: {toast_duration}"

            page.keyboard.press("ControlOrMeta+KeyK")
            page.wait_for_selector(".sk-palette", timeout=5000)
            palette_duration = page.eval_on_selector(
                ".sk-palette", "el => getComputedStyle(el).transitionDuration"
            )
            assert palette_duration in ("0s", ""), f"palette transition not instant: {palette_duration}"
            backdrop_duration = page.eval_on_selector(
                ".sk-palette-backdrop", "el => getComputedStyle(el).transitionDuration"
            )
            assert backdrop_duration in ("0s", ""), (
                f"palette backdrop transition not instant: {backdrop_duration}"
            )
        finally:
            context.close()
