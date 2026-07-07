"""§5.3 performance-budget measurements (WP-6.3) — spec §9 M6 criterion
"budgets met". Three budgets, three tests:

  1. First interactive (warm cache) < 1.5 s — measured on the SECOND load of
     editor/index.html in one browser context (the first load warms the HTTP
     cache; esm.sh serves immutable, long-max-age module responses). "First
     interactive" = navigation start → the CM6 editing surface (.cm-content)
     exists in the DOM, captured in-page by a MutationObserver installed
     before any script runs (so the number excludes test-harness polling
     latency). The spec's 1.5 s target is enforced on local dev runs; CI /
     container runs get a 3 s ceiling and the measured number is printed
     either way.

  2. Keystroke-to-paint p95 < 16 ms in a 50 KB doc with full decorations —
     adapts tests/unit/lang-storykit.test.js's §5.3 technique to the REAL
     integrated editor (every extension wired, lint, QID decorations): a
     capture-phase keydown listener stamps performance.now(), the next
     requestAnimationFrame callback records the delta (the JS+DOM work that
     delays the frame). ~40 real characters are typed through the CDP
     keyboard; p95 asserted < 16 ms locally / < 50 ms on CI.

  3. Edit-to-preview (split, cached context) < 2.5 s incl. debounce —
     the same probe as tests/e2e/test_m3_preview.py's latency test (kept
     there as the M3 gate; re-run here so the M6 audit records all three
     budget numbers in one report). CI-tolerant hard ceiling 4 s; the 2.5 s
     spec budget is verified on local runs.

Local-vs-CI thresholds: a run is treated as CI when the CI env var is set
(GitHub Actions) or /.dockerenv exists (the Linux-container check this repo
uses as its CI proxy). Local macOS dev runs get the strict spec numbers.

Hermeticity matches the other e2e suites: render_regression.py's route
interception + the documented live-esm.sh exception.
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import render_regression as rr  # noqa: E402

from conftest import _cached_chromium  # noqa: E402

MOUNT_TIMEOUT = 25_000  # ms

IS_CI = bool(os.environ.get("CI")) or Path("/.dockerenv").exists()

FIRST_INTERACTIVE_BUDGET_S = 3.0 if IS_CI else 1.5
KEYSTROKE_P95_BUDGET_MS = 50.0 if IS_CI else 16.0
EDIT_TO_PREVIEW_BUDGET_S = 4.0 if IS_CI else 2.5


# ── fixtures (mirror test_m6_keyboard.py) ───────────────────────────────────

@pytest.fixture(scope="session")
def site_dir():
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


def _create_and_open(page, title, path, content, mode):
    page.evaluate(
        """async ({ title, path, content, mode }) => {
            const app = await import('/editor/app.js');
            const rec = await app.modules.store.docs.create({ title, path, content });
            await app.openDoc(rec.id);
            app.setMode(mode);
        }""",
        {"title": title, "path": path, "content": content, "mode": mode},
    )
    page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)


def _fifty_kb_doc():
    """~50 KB of realistic StoryKit markup — the same generator as
    tests/unit/lang-storykit.test.js's §5.3 perf check, so both measurements
    exercise the same decoration/lint surface area."""
    block = (
        "Prose paragraph with a [Wikidata link](Q192017) and some length to it. "
        "More words follow here to pad the paragraph out to a reasonable size.\n\n"
        '{{% include embed/image.html id="img{i}" src="wc:Foo_{i}.jpg" caption="Cap {i}" %}}\n\n'
        'See [region](img{i}/zoomto/pct:10.5,20.5,30.5,40.5){{: label="Region {i}" }}.\n\n'
    )
    doc = "---\ntitle: Perf probe\ndate: 2026-01-01\n---\n\n"
    i = 0
    while len(doc) < 50 * 1024:
        doc += block.replace("{i}", str(i))
        i += 1
    return doc


# ── 1. first interactive, warm cache ────────────────────────────────────────

FIRST_INTERACTIVE_OBSERVER = """
window.__firstInteractive = null;
// Observe the Document node, NOT documentElement: init scripts run at
// document-start, before <html> exists on a real navigation.
new MutationObserver((_, obs) => {
  if (document.querySelector('.cm-content')) {
    window.__firstInteractive = performance.now();
    obs.disconnect();
  }
}).observe(document, { childList: true, subtree: true });
"""


def test_first_interactive_warm_cache(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            # Init script runs before ANY page script on every navigation, so
            # the reload below gets a fresh observer anchored to ITS
            # navigation start (performance.now() is per-navigation).
            page.add_init_script(FIRST_INTERACTIVE_OBSERVER)

            # Load 1 — warms the HTTP cache (esm.sh modules, styles, app.js)
            # AND seeds a document so the warm load restores it and mounts
            # the editor (the realistic returning-author path).
            _boot_editor(page, base_url)
            _create_and_open(
                page, "Warm-cache probe", None,
                "---\ntitle: Warm-cache probe\n---\n\nSome prose.\n", "edit",
            )

            # Load 2 — the measured, warm-cache boot.
            page.reload(wait_until="load", timeout=rr.POLL_TIMEOUT_MS)
            page.wait_for_selector(".cm-content", timeout=MOUNT_TIMEOUT)
            page.wait_for_function("() => window.__firstInteractive !== null",
                                   timeout=MOUNT_TIMEOUT)
            ms = page.evaluate("() => window.__firstInteractive")

            # ...and "interactive" means focusable: focus lands in the editor.
            page.evaluate(
                """async () => {
                    const { EditorView } = await import('@codemirror/view');
                    EditorView.findFromDOM(document.querySelector('#editor-mount')).focus();
                }"""
            )
            focused = page.evaluate(
                "() => document.activeElement && document.activeElement.classList.contains('cm-content')"
            )
            assert focused, "editor not focusable after warm boot"

            print(f"\n[perf] first interactive (warm cache): {ms / 1000:.2f}s "
                  f"(spec budget 1.5s; ceiling here {FIRST_INTERACTIVE_BUDGET_S}s)")
            assert ms / 1000 < FIRST_INTERACTIVE_BUDGET_S, (
                f"first interactive {ms / 1000:.2f}s exceeds "
                f"{FIRST_INTERACTIVE_BUDGET_S}s ({'CI' if IS_CI else 'local'} ceiling)"
            )
        finally:
            context.close()


# ── 2. keystroke-to-paint p95 in a 50 KB document ───────────────────────────

KEYSTROKE_PROBE = """
() => {
  window.__kp = [];
  const cm = document.querySelector('.cm-content');
  cm.addEventListener('keydown', () => {
    const t0 = performance.now();
    requestAnimationFrame(() => window.__kp.push(performance.now() - t0));
  }, true);
}
"""


def test_keystroke_to_paint_p95_50kb_doc(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _create_and_open(
                page, "Keystroke probe", "_posts/2026-07-06-keystroke-probe.md",
                _fifty_kb_doc(), "edit",
            )
            # Put the caret mid-document (inside prose, decorations all around).
            page.evaluate(
                """async () => {
                    const { EditorView } = await import('@codemirror/view');
                    const view = EditorView.findFromDOM(document.querySelector('#editor-mount'));
                    view.dispatch({ selection: { anchor: 5000 } });
                    view.focus();
                }"""
            )
            page.wait_for_function(
                "() => document.activeElement && document.activeElement.classList.contains('cm-content')",
                timeout=5000,
            )
            page.evaluate(KEYSTROKE_PROBE)

            # ~40 real characters through the CDP keyboard. A small delay
            # keeps each keystroke in its own frame (measuring per-keystroke
            # latency, not event coalescing).
            page.keyboard.type("The quick brown fox jumps over the lazy dog", delay=40)

            page.wait_for_function("() => window.__kp.length >= 40", timeout=10_000)
            samples = page.evaluate("() => window.__kp")

            samples.sort()
            p95 = samples[int(len(samples) * 0.95) - 1]
            median = samples[len(samples) // 2]
            print(f"\n[perf] keystroke-to-paint over {len(samples)} keystrokes: "
                  f"median {median:.2f}ms, p95 {p95:.2f}ms "
                  f"(spec budget 16ms p95; ceiling here {KEYSTROKE_P95_BUDGET_MS}ms)")
            assert p95 < KEYSTROKE_P95_BUDGET_MS, (
                f"keystroke-to-paint p95 {p95:.2f}ms exceeds "
                f"{KEYSTROKE_P95_BUDGET_MS}ms ({'CI' if IS_CI else 'local'} ceiling)"
            )
        finally:
            context.close()


# ── 3. edit-to-preview in split mode ────────────────────────────────────────

def test_edit_to_preview_split_mode(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _create_and_open(
                page, "Preview latency probe", "_posts/2026-07-06-pv-latency.md",
                "---\ntitle: Preview latency probe\n---\n\nHello preview.\n", "split",
            )
            frame_el = page.locator("#preview-mount iframe.pv-frame")
            frame_el.wait_for(state="attached", timeout=rr.POLL_TIMEOUT_MS)
            rr._poll_srcdoc(page, frame_el)  # initial render settled

            before = frame_el.get_attribute("srcdoc") or ""
            page.locator(".cm-content").click()
            page.keyboard.press("End")
            page.keyboard.type(" EDITMARKER")
            start = time.monotonic()
            deadline = start + 8.0
            elapsed = None
            while time.monotonic() < deadline:
                cur = frame_el.get_attribute("srcdoc") or ""
                if cur != before and "EDITMARKER" in cur:
                    elapsed = time.monotonic() - start
                    break
                page.wait_for_timeout(50)
            assert elapsed is not None, "preview never reflected the edit"
            print(f"\n[perf] edit-to-preview (split): {elapsed:.2f}s "
                  f"(spec budget 2.5s incl. ~1s debounce; ceiling here {EDIT_TO_PREVIEW_BUDGET_S}s)")
            assert elapsed < EDIT_TO_PREVIEW_BUDGET_S, (
                f"edit-to-preview {elapsed:.2f}s exceeds "
                f"{EDIT_TO_PREVIEW_BUDGET_S}s ({'CI' if IS_CI else 'local'} ceiling)"
            )
        finally:
            context.close()
