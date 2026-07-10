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


def test_absent_alt_gets_commons_caption_empty_alt_suppresses(browser, site_dir):
    """Caption rules for Commons headers: alt ABSENT → auto-caption from the
    Commons image description; alt EXPLICITLY EMPTY (alt="") → no caption.
    The fixture page ships alt text, so both cases are staged by editing the
    live DOM and re-running init (the same entry point the page uses)."""
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

        # alt ABSENT → auto-caption
        cap = page.evaluate(
            """async () => {
                const img = document.querySelector('.preview-img img, img.preview-img');
                const box = img.closest('div');
                box.querySelector('figcaption')?.remove();
                box.querySelector('.sk-header-attribution')?.remove();
                img.removeAttribute('alt');
                const m = await import('/storykit-starter/assets/js/storykit.js');
                m.initStoryKit({});
                await new Promise(r => setTimeout(r, 800));
                return box.querySelector('figcaption')?.textContent || null;
            }""")
        assert cap == "Terraced vineyards in late winter", cap

        # alt EMPTY ("") → caption suppressed, attribution still present
        state = page.evaluate(
            """async () => {
                const img = document.querySelector('.preview-img img, img.preview-img');
                const box = img.closest('div');
                box.querySelector('figcaption')?.remove();
                box.querySelector('.sk-header-attribution')?.remove();
                img.setAttribute('alt', '');
                const m = await import('/storykit-starter/assets/js/storykit.js');
                m.initStoryKit({});
                await new Promise(r => setTimeout(r, 800));
                return { caption: !!box.querySelector('figcaption'),
                         attribution: !!box.querySelector('.sk-header-attribution') };
            }""")
        assert state == {"caption": False, "attribution": True}, state
    finally:
        context.close()
