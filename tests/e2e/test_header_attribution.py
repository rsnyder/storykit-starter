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
    try:
        page.route("https://rsnyder.github.io/**", _route_site)
        page.route("https://commons.wikimedia.org/**",
                   lambda r: r.fulfill(status=200, body=json.dumps(META),
                                       content_type="application/json"))
        page.goto("https://rsnyder.github.io/storykit-starter/admin/storykit-regression-fixture-wc-header",
                  wait_until="load", timeout=60_000)
        page.wait_for_selector(".sk-header-attribution", timeout=20_000)
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

    # NOTE: bare `alt:` parses as YAML null — indistinguishable from absent
    # (and gets the auto-caption). The expressible opt-out is alt: "".
    empty = case('  alt: ""\n', 'empty')
    assert empty["skAlt"] == "empty", empty
    assert empty["caption"] is None, empty
    assert empty["attribution"], empty
