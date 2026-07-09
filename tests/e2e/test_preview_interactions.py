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

FRONT = "---\ntitle: Interaction probe\nmedia_subpath: /assets/posts/monument-valley\n---\n\n"

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

    def load(content):
        page.evaluate(
            """async (content) => {
                const app = await import('/storykit-starter/editor/app.js');
                const rec = await app.modules.store.docs.create({
                    title: 'Interaction probe',
                    path: '_posts/2026-07-08-interaction-probe.md', content });
                await app.openDoc(rec.id);
                app.setMode('preview');
            }""", content)
        fr = page.locator("#preview-mount iframe.pv-frame")
        fr.wait_for(state="attached", timeout=30000)
        rr._poll_srcdoc(page, fr)

    yield page, load
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


EXPAND_CASES = {
    # name: (include tag, component frame selector, click target selector)
    "image-wc": (
        '{% include embed/image.html id="v1" src="wc:Monument_Valley,_Utah,_USA.jpg" %}',
        "iframe.embed-image", "#osd"),
    "image-local": (
        '{% include embed/image.html id="v1" src="Monument_Valley.jpg" %}',
        "iframe.embed-image", "#osd"),
    "map": (
        '{% include embed/map.html id="v1" center="37.01056, -110.2425" zoom="10" %}',
        "iframe.embed-map", "#expandBtn"),
    "youtube": (
        '{% include embed/youtube.html id="v1" vid="yg0As_HOvJk" %}',
        "iframe.embed-youtube", "body"),
    "image-compare": (
        '{% include embed/image-compare.html '
        'before="/assets/posts/image-compare/Westgate_Towers_c1905.jpg" '
        'after="/assets/posts/image-compare/Westgate_Towers_2021.jpg" %}',
        "iframe.embed-image-compare", '[aria-label="Click to enlarge"]'),
}


@pytest.mark.parametrize("case", list(EXPAND_CASES))
def test_clicking_a_viewer_opens_the_expand_dialog(editor_prod, case):
    page, load = editor_prod
    tag, frame_sel, click_sel = EXPAND_CASES[case]
    load(FRONT + tag + "\n")
    v = page.frame_locator("#preview-mount iframe.pv-frame").frame_locator(frame_sel).first
    v.locator(click_sel).wait_for(timeout=45000)
    page.wait_for_timeout(2000)  # let the component runtime finish wiring
    v.locator(click_sel).click(position={"x": 30, "y": 30} if click_sel == "#osd" else None)
    opened = False
    for _ in range(24):
        st = _dialog_state(page)
        if st["open"] and st["hasIframe"]:
            opened = True
            break
        page.wait_for_timeout(250)
    assert opened, f"[{case}] expand dialog did not open: {_dialog_state(page)}"


def test_action_link_zoomto_reaches_the_component(editor_prod):
    """Host→component direction: clicking a zoomto action link must deliver
    a storykit:action message into the viewer iframe (targetOrigin path)."""
    page, load = editor_prod
    load(DOC)
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


def test_expand_works_when_editor_is_cross_origin_with_components(playwright, built_site):
    """The local-dev topology: editor page on a localhost origin while
    components load from the deployed origin (assetOrigin = config.url).
    Pins the cross-origin trust model — component runtime derives the
    embedder origin from document.referrer; the host trusts the origins its
    component iframes actually load from (registerComponentOrigins)."""
    import http.server, functools, socket, threading
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SITE))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_context(locale="en-US", timezone_id="UTC").new_page()
        page.route(f"{ORIGIN}/**", _route_site)          # deployed origin ← local _site
        page.route("https://raw.githubusercontent.com/**", _route_raw)
        page.route("https://res.cloudinary.com/**", _route_cloudinary)
        page.goto(f"http://127.0.0.1:{port}/editor/index.html", wait_until="load", timeout=60000)
        page.wait_for_selector("#new-doc:not([disabled])", timeout=30000)
        page.evaluate(
            """async (content) => {
                const app = await import('/editor/app.js');
                const rec = await app.modules.store.docs.create({
                    title: 'XO', path: '_posts/2026-07-08-xo.md', content });
                await app.openDoc(rec.id);
                app.setMode('preview');
            }""",
            FRONT + '{% include embed/image.html id="v1" src="Monument_Valley.jpg" %}\n')
        fr = page.locator("#preview-mount iframe.pv-frame")
        fr.wait_for(state="attached", timeout=30000)
        rr._poll_srcdoc(page, fr)
        v = page.frame_locator("#preview-mount iframe.pv-frame").frame_locator(
            "iframe.embed-image").first
        v.locator("#osd").wait_for(timeout=45000)
        page.wait_for_timeout(2000)
        # sanity: components really are cross-origin with the page
        comp = page.evaluate("""() => {
            const d = document.querySelector('#preview-mount iframe.pv-frame').contentDocument;
            return d.querySelector('iframe.embed-image').src; }""")
        assert comp.startswith(ORIGIN), f"expected cross-origin components, got {comp}"
        v.locator("#osd").click(position={"x": 30, "y": 30})
        opened = False
        for _ in range(24):
            st = _dialog_state(page)
            if st["open"] and st["hasIframe"]:
                opened = True
                break
            page.wait_for_timeout(250)
        assert opened, f"cross-origin expand failed: {_dialog_state(page)}"
    finally:
        browser.close()
        httpd.shutdown()


def test_footnote_click_stays_in_document(editor_prod):
    """Regression pin: about:srcdoc inherits its BASE URL from the embedder,
    so bare #fragment links (footnotes, heading anchors) resolved against the
    EDITOR's URL — clicking a footnote replaced the preview with a second
    editor instance. skrender now injects a fragment-click handler that
    scrolls in-document instead."""
    page, load = editor_prod
    load(FRONT + "Text with a footnote.[^1]\n\n" + ("Filler paragraph. " * 40 + "\n\n") * 8 +
         "[^1]: The footnote text lives far below.\n")
    frame = page.frame_locator("#preview-mount iframe.pv-frame")
    frame.locator("sup.footnote-ref a, a.footnote").first.wait_for(timeout=30_000)
    page.wait_for_timeout(500)
    frame.locator("sup.footnote-ref a, a.footnote").first.click()
    page.wait_for_timeout(1500)  # smooth scroll
    state = page.evaluate(
        """() => {
            const f = document.querySelector('#preview-mount iframe.pv-frame');
            const d = f.contentDocument;
            return {
                stillSrcdoc: !!f.srcdoc && d.location.href.startsWith('about:srcdoc'),
                hasFootnotes: !!d.querySelector('.footnotes, #fn1, [id^=fn]'),
                scrolled: f.contentWindow.scrollY > 100,
                noNestedEditor: !d.querySelector('#doclist-mount'),
            };
        }""")
    assert state["stillSrcdoc"], f"iframe navigated away: {state}"
    assert state["noNestedEditor"], "editor loaded inside the preview"
    assert state["hasFootnotes"] and state["scrolled"], f"should scroll to the footnote: {state}"
