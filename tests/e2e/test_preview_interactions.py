"""Viewer interactivity inside the editor preview (component↔host messaging).

Regression pin for the srcdoc-origin bug: inside an about:srcdoc document
(how both the preview tool and the editor preview render posts),
`location.origin` serializes as the literal string "null" even though the
document's SECURITY origin is inherited from the embedder. storykit.js used
`location.origin` for its allowed-origins set and postMessage targetOrigin,
silently killing ALL component↔host messaging in every preview surface:
clicking a viewer never opened the expanded dialog, action links did
nothing. Fixed via HOST_ORIGIN (window.origin fallback) in storykit.js.

TECHNIQUE — production-origin emulation: the messaging only behaves as
deployed when the editor page, the srcdoc, and the component iframes all
share the production origin. Playwright routes fulfill every
https://rsnyder.github.io/storykit-starter/** request from the local _site
build, so the browser sees the production origin while running the working
tree's code. raw.githubusercontent (the unbound editor context) is served
from the working tree. openseadragon/fonts CDNs ride live, matching the
established esm.sh exception.
"""

import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import render_regression as rr  # noqa: E402

SITE = REPO / "_site"
ORIGIN = "https://rsnyder.github.io"
BASEPATH = "/storykit-starter/"

CTYPES = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".map": "application/json", ".webp": "image/webp",
}

DOC = (
    "---\ntitle: Interaction probe\nmedia_subpath: /assets/posts/monument-valley\n---\n\n"
    "Before the viewer.\n\n"
    "{% include embed/image.html id=\"img1\" src=\"Monument_Valley.jpg\" %}\n\n"
    "Zoom to [the buttes](img1/zoomto/pct:10,10,40,40).\n"
)


def _route_site(route):
    rel = unquote(urlparse(route.request.url).path)
    if rel.startswith(BASEPATH):
        rel = rel[len(BASEPATH):]
    f = SITE / rel
    if f.is_dir():
        f = f / "index.html"
    if not f.exists() and not f.suffix:
        alt = f.with_suffix(".html")
        if alt.exists():
            f = alt
    if f.exists() and f.is_file():
        route.fulfill(status=200, body=f.read_bytes(),
                      content_type=CTYPES.get(f.suffix, "application/octet-stream"))
    else:
        route.fulfill(status=404, body=b"not found")


def _route_cloudinary(route):
    """The site's `cdn:` config wraps local images in a Cloudinary fetch proxy
    (res.cloudinary.com/.../image/fetch/<transforms>/<origin-url>). Unwrap the
    origin URL and serve it from _site so the viewer loads hermetically."""
    url = route.request.url
    marker = ORIGIN + BASEPATH
    i = url.find(marker)
    if i == -1:
        route.fulfill(status=404, body=b"unproxied")
        return
    f = SITE / unquote(urlparse(url[i:]).path)[len(BASEPATH):]
    if f.exists() and f.is_file():
        route.fulfill(status=200, body=f.read_bytes(),
                      content_type=CTYPES.get(f.suffix, "application/octet-stream"))
    else:
        route.fulfill(status=404, body=b"not found")


def _route_raw(route):
    parts = urlparse(route.request.url).path.split("/", 4)
    data = rr._tree_file_bytes(unquote(parts[4])) if len(parts) > 4 else None
    if data is None:
        route.fulfill(status=404, body=b"missing")
    else:
        route.fulfill(status=200, body=data, content_type="text/plain; charset=utf-8")


# Local site build guard (mirrors test_m3's fixture without importing it).
@pytest.fixture(scope="session")
def built_site():
    assert (SITE / "editor" / "index.html").exists(), \
        "_site not built — run `bundle exec jekyll build` first (CI builds before e2e)"
    return SITE


@pytest.fixture()
def editor_prod(playwright, built_site):
    """Editor page under production-origin emulation; yields (page, close)."""
    browser = playwright.chromium.launch(headless=True)
    context = browser.new_context(locale="en-US", timezone_id="UTC")
    page = context.new_page()
    page.route(f"{ORIGIN}/**", _route_site)
    page.route("https://raw.githubusercontent.com/**", _route_raw)
    page.route("https://res.cloudinary.com/**", _route_cloudinary)
    page.goto(f"{ORIGIN}{BASEPATH}editor/index.html", wait_until="load", timeout=60000)
    page.wait_for_selector("#new-doc:not([disabled])", timeout=30000)
    page.evaluate(
        """async (content) => {
            const app = await import('/storykit-starter/editor/app.js');
            const rec = await app.modules.store.docs.create({
                title: 'Interaction probe',
                path: '_posts/2026-07-08-interaction-probe.md', content });
            await app.openDoc(rec.id);
            app.setMode('preview');
        }""", DOC)
    fr = page.locator("#preview-mount iframe.pv-frame")
    fr.wait_for(state="attached", timeout=30000)
    rr._poll_srcdoc(page, fr)
    yield page
    context.close()
    browser.close()


def _viewer(page):
    return page.frame_locator("#preview-mount iframe.pv-frame").frame_locator(
        "iframe.embed-image").first


def _dialog_state(page):
    return page.evaluate("""() => {
        const fr = document.querySelector('#preview-mount iframe.pv-frame');
        const sl = fr.contentDocument.getElementById('storykitDialog');
        return { present: !!sl,
                 open: sl ? (sl.open === true || sl.hasAttribute('open')) : false,
                 hasIframe: sl ? !!sl.querySelector('iframe') : false };
    }""")


def test_clicking_a_viewer_opens_the_expand_dialog(editor_prod):
    page = editor_prod
    v = _viewer(page)
    v.locator("#osd").wait_for(timeout=45000)
    page.wait_for_timeout(1500)  # let the component runtime finish wiring
    v.locator("#osd").click(position={"x": 40, "y": 40})
    deadline_ok = False
    for _ in range(20):
        st = _dialog_state(page)
        if st["open"] and st["hasIframe"]:
            deadline_ok = True
            break
        page.wait_for_timeout(250)
    assert deadline_ok, f"expand dialog did not open: {_dialog_state(page)}"


def test_action_link_zoomto_reaches_the_component(editor_prod):
    """Host→component direction: clicking a zoomto action link must deliver
    a storykit:action message into the viewer iframe (targetOrigin path)."""
    page = editor_prod
    v = _viewer(page)
    v.locator("#osd").wait_for(timeout=45000)
    page.wait_for_timeout(1500)
    # instrument the component window to record incoming storykit:action
    page.evaluate("""() => {
        const fr = document.querySelector('#preview-mount iframe.pv-frame');
        const inner = fr.contentDocument.querySelector('iframe.embed-image');
        const w = inner.contentWindow;
        w.__actions = [];
        w.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'storykit:action') w.__actions.push(e.data.payload);
        }, true);
    }""")
    pv = page.frame_locator("#preview-mount iframe.pv-frame")
    pv.locator('a.trigger[data-action="zoomto"], a.trigger[data-args*="pct"]').first.click()
    got = None
    for _ in range(20):
        got = page.evaluate("""() => {
            const fr = document.querySelector('#preview-mount iframe.pv-frame');
            const inner = fr.contentDocument.querySelector('iframe.embed-image');
            return inner.contentWindow.__actions;
        }""")
        if got:
            break
        page.wait_for_timeout(250)
    assert got, "no storykit:action message reached the component"
    assert got[0]["action"] == "zoomto"
