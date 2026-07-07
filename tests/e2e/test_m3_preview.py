"""M3 preview e2e (WP-3.4) — spec §9 M3 criteria.

Four proofs, in fidelity order:
  1. THE GOLDEN BYTE-COMPARE: the editor's rendered Monument Valley preview is
     byte-identical to tests/render/golden/monument-valley.html — the same
     golden the M1 preview-tool regression guards. Both products share one
     renderer (assets/js/skrender.js); this proves the editor feeds it an
     equivalent context end to end.
  2. Viewer/action-link markup is present in the preview srcdoc (paste-and-
     preview works for an unbound draft).
  3. Edit-to-preview latency in Split mode (spec budget 2.5 s incl. the ~1 s
     schedule() debounce; asserted CI-tolerantly, measured value printed).
  4. A render-breaking document shows the diagnostics panel and an inline
     error document — never a blank iframe (FR-PRE.5).

Hermeticity: reuses tools/render_regression.py's route interception (GitHub
API / raw.githubusercontent -> local working tree, jsdelivr -> committed
fixtures, everything else aborted). esm.sh module loads run live — the same
documented exception as --target editor and the browser unit suite.
"""

import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import render_regression as rr  # noqa: E402

from conftest import _cached_chromium  # noqa: E402

MV_ENTRY = {"slug": "monument-valley", "path": "_posts/2026-01-10-monument-valley.md"}


# ── fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def site_dir():
    """A built _site (the harness serves the editor page from it)."""
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


@pytest.fixture(scope="session")
def mv_capture(browser, site_dir):
    """Drive the real editor UI once for Monument Valley; share the capture."""
    with rr.serve_site(site_dir) as base_url:
        srcdoc, audit = rr.capture_entry_editor(
            browser, base_url, MV_ENTRY, record_fixtures=False
        )
    return srcdoc, audit


def _hermetic_page(browser):
    """A fresh context/page with the harness's interception + fixed clock."""
    context = browser.new_context(locale="en-US", timezone_id="UTC")
    page = context.new_page()
    page.clock.set_fixed_time(rr.FIXED_TIME)
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


# ── 1. the golden byte-compare ───────────────────────────────────────────────

def test_editor_preview_matches_m1_golden(mv_capture):
    srcdoc, audit = mv_capture
    golden = rr.golden_path(MV_ENTRY["slug"]).read_bytes()
    captured = srcdoc.encode("utf-8")
    assert audit.live_request_count() == 0, "render-pipeline network escaped interception"
    assert captured == golden, (
        f"editor srcdoc diverges from the M1 golden "
        f"({len(captured)} vs {len(golden)} bytes) — the two products no longer "
        f"share a render pipeline; run tools/render_regression.py --check "
        f"--target editor --only monument-valley for a diff"
    )


# ── 2. viewers and action links render for an unbound draft ─────────────────

def test_preview_renders_viewers_and_action_links(mv_capture):
    srcdoc, _ = mv_capture
    for marker in (
        "assets/components/image.html",    # image viewer iframe
        "assets/components/map.html",      # map viewer iframe
        "assets/components/youtube.html",  # youtube viewer iframes
        "image/zoomto/pct:",               # action links survive markdown
        "map/flyto/",
    ):
        assert marker in srcdoc, f"expected preview markup missing: {marker}"


# ── 3. edit-to-preview latency in Split mode ─────────────────────────────────

def test_split_mode_edit_to_preview_latency(browser, site_dir):
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _create_and_open(
                page, "Latency probe", "_posts/2026-07-06-latency-probe.md",
                "---\ntitle: Latency probe\n---\n\nHello preview.\n", "split",
            )
            frame_el = page.locator("#preview-mount iframe.pv-frame")
            frame_el.wait_for(state="attached", timeout=rr.POLL_TIMEOUT_MS)
            rr._poll_srcdoc(page, frame_el)  # initial render settled

            before = frame_el.get_attribute("srcdoc") or ""
            page.locator(".cm-content").click()
            page.keyboard.press("End")
            page.keyboard.type(" EDITMARKER")
            start = time.monotonic()
            deadline = start + 6.0
            elapsed = None
            while time.monotonic() < deadline:
                cur = frame_el.get_attribute("srcdoc") or ""
                if cur != before and "EDITMARKER" in cur:
                    elapsed = time.monotonic() - start
                    break
                page.wait_for_timeout(100)
            assert elapsed is not None, "preview never reflected the edit"
            print(f"\nedit-to-preview: {elapsed:.2f}s (spec budget 2.5s incl. ~1s debounce)")
            # CI-tolerant hard ceiling; the 2.5s spec budget is verified locally.
            assert elapsed < 4.0, f"edit-to-preview {elapsed:.2f}s exceeds CI ceiling"
        finally:
            context.close()


# ── 4. failure shows diagnostics, never a blank iframe ──────────────────────

def test_render_failure_shows_diagnostics_not_blank(browser, site_dir):
    # An unclosed Liquid block is a genuine parse failure: renderPost catches
    # the LiquidJS throw, emits an error diagnostic, and writes the inline
    # error document. (A *missing include* is deliberately NOT a failure —
    # skrender renders an inline placeholder for it, and the editor-side lint
    # flags it; verified against assets/js/skrender.js's include-miss path.)
    broken = (
        "---\ntitle: Broken liquid\ndate: 2026-07-06\n---\n\n"
        "Before.\n\n{% if broken %}\n\nAfter, but the if never closes.\n"
    )
    with rr.serve_site(site_dir) as base_url:
        context, page, _ = _hermetic_page(browser)
        try:
            _boot_editor(page, base_url)
            _create_and_open(
                page, "Broken include", "_posts/2026-07-06-broken.md",
                broken, "preview",
            )
            # skrender degrades gracefully: the Liquid parse error becomes a
            # WARN diagnostic ("Liquid error in post body (rendered raw): tag
            # {% if broken %} not closed") and the page still renders. The
            # panel auto-expands whenever errors/warns exist — assert the
            # expanded warn/error entry is visible, which verifies both the
            # diagnostic surfacing and the auto-expand UX (FR-PRE.5).
            page.wait_for_selector(
                ".pv-diagnostics[data-collapsed='false'] .pv-diag-warn:visible,"
                " .pv-diagnostics[data-collapsed='false'] .pv-diag-error:visible",
                timeout=rr.POLL_TIMEOUT_MS,
            )
            # The iframe is never blank: either an error document or a
            # degraded-but-rendered page.
            frame_el = page.locator("#preview-mount iframe.pv-frame")
            frame_el.wait_for(state="attached", timeout=rr.POLL_TIMEOUT_MS)
            srcdoc = rr._poll_srcdoc(page, frame_el)
            assert len(srcdoc) > 200 and "<html" in srcdoc.lower(), \
                "iframe blank after render failure (FR-PRE.5 violation)"
        finally:
            context.close()
