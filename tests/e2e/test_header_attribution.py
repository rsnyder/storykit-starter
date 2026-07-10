"""Header-image attribution (storykit.js headerAttribution + post.html).

The artist/license segment appears in ALL cases for Commons headers (the
mocked metadata deliberately says AttributionRequired=false to pin that).

Commons-hosted header images get an automatic attribution line, formatted
like the image viewer's: 'Source: Wikimedia Commons • © Artist — License'
(the © segment only when the license requires it). Hermetic: the fixture
page is served from _site via routes; the Commons API is mocked.
"""

import json
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import render_regression as rr  # noqa: E402

from test_m5_sync import browser, site_dir  # noqa: E402,F401
from test_preview_interactions import editor_prod, built_site  # noqa: E402,F401

SITE = REPO / "_site"
CT = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml"}


def _route_site(route):
    rel = unquote(urlparse(route.request.url).path)
    if rel.startswith("/storykit-starter/"):
        rel = rel[len("/storykit-starter/"):]
    f = SITE / rel.lstrip("/")
    if f.is_dir():
        f = f / "index.html"
    if not f.exists() and not f.suffix and f.with_suffix(".html").exists():
        f = f.with_suffix(".html")
    if f.is_file():
        route.fulfill(status=200, body=f.read_bytes(),
                      content_type=CT.get(f.suffix, "application/octet-stream"))
    else:
        route.fulfill(status=404, body=b"x")


# minimal valid JPEG (1x1) for hermetic image responses
PIXEL = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707"
    "07090908080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c23"
    "1c1c2837292c30313434341f27393d38323c2e333432ffc0000b0800010001010100"
    "11003fffc4001f0000010501010101010100000000000000000102030405060708090a0b"
    "ffc400b5100002010303020403050504040000017d01020300041105122131410613"
    "516107227114328191a1082342b1c11552d1f02433627282090a161718191a252627"
    "28292a3435363738393a434445464748494a535455565758595a636465666768696a"
    "737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aa"
    "b2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7"
    "e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbfe8a28a2800a28a2800a"
    "28a2803fffd9")

META = {"query": {"pages": {"1": {"imageinfo": [{"extmetadata": {
    "AttributionRequired": {"value": "false"},
    "Artist": {"value": "Jane Photographer"},
    "LicenseShortName": {"value": "CC BY-SA 4.0"},
    "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0"},
    "ImageDescription": {"value": "<span>Terraced vineyards in late winter</span>"},
}}]}}}}


def test_commons_header_gets_attribution_line(browser, site_dir):
    context = browser.new_context()
    page = context.new_page()
    # CI-only failure diagnostics: this test passes locally and in the CI
    # container but has failed repeatedly on real runners — collect evidence.
    console, perrors, failed_reqs = [], [], []
    page.on("console", lambda m: console.append(f"{m.type}: {m.text[:160]}"))
    page.on("pageerror", lambda e: perrors.append(str(e)[:200]))
    page.on("requestfailed",
            lambda r: failed_reqs.append(f"{r.url[:120]} :: {r.failure}"))
    try:
        page.route("https://rsnyder.github.io/**", _route_site)
        page.route("https://commons.wikimedia.org/**",
                   lambda r: r.fulfill(status=200, body=json.dumps(META),
                                       content_type="application/json"))
        # hermetic media: CI runners' live wikimedia fetches are slow/flaky
        page.route("https://upload.wikimedia.org/**",
                   lambda r: r.fulfill(status=200, body=PIXEL, content_type="image/jpeg"))
        # NOTE: storykit.js statically imports js-md5 + Shoelace (jsdelivr)
        # and scrollama (cdnjs) — those CDNs must stay LIVE (aborting any of
        # them kills the whole module; the rest of the e2e suite rides the
        # same live-CDN exception). Only wikimedia/commons are mocked.
        page.goto("https://rsnyder.github.io/storykit-starter/admin/storykit-regression-fixture-wc-header",
                  wait_until="domcontentloaded", timeout=60_000)
        try:
            page.wait_for_selector(".sk-header-attribution", timeout=45_000)
        except Exception:
            print("\n=== CI DIAGNOSTICS (attribution never appeared) ===")
            print("--- page errors ---")
            for x in perrors[:10]: print(" ", x)
            print("--- failed requests ---")
            for x in failed_reqs[:20]: print(" ", x)
            print("--- console (errors/warnings) ---")
            for x in console:
                if x.startswith(("error", "warning")): print(" ", x)
            print("--- module import probe ---")
            print(" ", page.evaluate(
                """async () => { try { const m = await import('/storykit-starter/assets/js/storykit.js');
                     return 'import ok: ' + typeof m.initStoryKit; }
                     catch (e) { return 'import FAILED: ' + String(e).slice(0, 200); } }"""))
            raise
        state = page.evaluate(
            """() => {
                const el = document.querySelector('.sk-header-attribution');
                return { text: el.textContent,
                         count: document.querySelectorAll('.sk-header-attribution').length,
                         sourceLink: !!el.querySelector('a[href*="commons.wikimedia.org"]'),
                         licenseLink: !!el.querySelector('a[rel~="license"]') };
            }""")
        assert state["count"] == 1
        assert "Source: Wikimedia Commons" in state["text"]
        assert "© Jane Photographer" in state["text"] and "CC BY-SA 4.0" in state["text"]
        assert state["sourceLink"] and state["licenseLink"]
    finally:
        context.close()


def test_alt_rules_through_the_real_pipeline(editor_prod):
    """Caption rules verified through the REAL render pipeline (the editor
    preview renders post.html via skrender — the same layout the deployed
    site uses): alt ABSENT → data-sk-alt=absent → auto-caption from Commons;
    alt EMPTY → data-sk-alt=empty → no caption; attribution in both cases.
    (The previous DOM-staged version of this test passed while the real
    pipeline failed — Chirpy's alt fallback made absent/empty invisible.)"""
    page, load = editor_prod
    page.route("https://commons.wikimedia.org/**",
               lambda r: r.fulfill(status=200, body=json.dumps(META),
                                   content_type="application/json"))

    def case(front_matter_alt_line, expected_mark):
        load("---\ntitle: Alt case\nimage:\n"
             "  path: wc:Monument_Valley,_Utah,_USA.jpg\n"
             + front_matter_alt_line + "---\n\nBody.\n")
        # wait for THIS case's render (the marker distinguishes it from the
        # previous document's still-displayed srcdoc) + the async attribution
        page.wait_for_function(
            """(mark) => {
                const f = document.querySelector('#preview-mount iframe.pv-frame');
                const d = f && f.contentDocument;
                const img = d && d.querySelector('.preview-img img, img.preview-img');
                return img && img.dataset.skAlt === mark
                    && d.querySelector('.sk-header-attribution'); }""",
            arg=expected_mark, timeout=45_000)
        return page.evaluate(
            """() => {
                const d = document.querySelector('#preview-mount iframe.pv-frame').contentDocument;
                const img = d.querySelector('.preview-img img, img.preview-img');
                const box = img.closest('div');
                return { skAlt: img.dataset.skAlt || null,
                         caption: box.querySelector('figcaption')?.textContent || null,
                         attribution: !!box.querySelector('.sk-header-attribution') };
            }""")

    absent = case("", "absent")             # no alt line at all
    assert absent["skAlt"] == "absent", absent
    assert absent["caption"] == "Terraced vineyards in late winter", absent
    assert absent["attribution"], absent

    # bare `alt:` (YAML null) and alt: "" both mean present-but-empty —
    # the author's caption opt-out (detected via key iteration in the layout)
    empty = case("  alt:\n", "empty")
    assert empty["skAlt"] == "empty", empty
    assert empty["caption"] is None, empty
    assert empty["attribution"], empty

    empty = case('  alt: ""\n', "empty")
    assert empty["skAlt"] == "empty", empty
    assert empty["caption"] is None, empty
    assert empty["attribution"], empty
