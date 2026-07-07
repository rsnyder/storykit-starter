#!/usr/bin/env python3
"""
render_regression.py — Render-regression harness for preview/index.html
=======================================================================

The M1 safety gate for the StoryKit editor project (WP-1.1). Drives the
client-side Jekyll/Chirpy renderer in ``preview/index.html`` HERMETICALLY
(zero live network) and captures the pre-JS ``srcdoc`` string it writes into
``#__preview-frame`` for each corpus entry, so the upcoming renderer-extraction
refactor (WP-1.2) can be proven byte-for-byte non-regressing.

WHAT IT DOES
    1. Serves the built site (``_site``) on a free ephemeral port (never 4000),
       or uses ``--url`` for an already-running server.
    2. For each corpus entry (tests/render/corpus.json) opens
       ``preview/index.html#<payload>`` with a fresh browser context.
    3. Intercepts ALL network via ``page.route()`` — nothing reaches the
       internet:
         a. api.github.com/repos/<owner>/<repo>/contents/<path>?ref=<ref>
              -> GitHub-shaped base64 JSON built from the LOCAL WORKING TREE.
         b. raw.githubusercontent.com/...  -> local working tree (text).
         c. cdn.jsdelivr.net/**            -> committed fixtures under
              tests/render/fixtures/cdn/<path> (covers both the /npm/ preview
              libraries AND the /gh/cotes2020 Chirpy gem files). ``--record-fixtures``
              performs the one-time live capture into that dir.
         d. Everything else (deployed-origin assets, cdnjs Font Awesome, and any
              iframe/child-frame subresource) is ABORTED — it never affects the
              captured srcdoc string.
    4. Freezes wall-clock time (``page.clock.set_fixed_time``) + pins the browser
       locale/timezone so the in-iframe preview banner timestamp
       (``new Date().toLocaleTimeString()``, preview/index.html:1245) and any
       ``site.time`` / dateless ``page.date`` fallbacks are deterministic.

MODES
    --capture            write tests/render/golden/<slug>.html
    --check              byte-compare against goldens; unified diff + exit 1 on drift
    --record-fixtures    let cdn.jsdelivr.net requests through ONCE, save responses
                         into the fixtures dir, report what was recorded
    --only <slug>        restrict to corpus entry/entries (comma-separated)

TARGETS  (--target preview [default] | editor)
    --target preview      drives preview/index.html via its `#<payload>` hash API
                           (the M1 gate — unchanged behaviour, all of the above).
    --target editor        THE M3 FIDELITY PROOF (WP-3.4). Drives editor/index.html
                           through the real UI/store: creates a document whose
                           content + path are the corpus entry's WORKING-TREE
                           source, opens it, switches to Preview mode, and captures
                           the resulting `<iframe class="pv-frame">` srcdoc — then
                           byte-compares it against the SAME golden the preview
                           target uses (tests/render/golden/<slug>.html). Because
                           both targets ultimately call the one shared
                           assets/js/skrender.js renderPost() with equivalent
                           context shapes (editor/context.js's unbound mode fetches
                           this starter's own raw.githubusercontent content, same
                           as the preview shell's payload here), the two outputs
                           are expected to be byte-IDENTICAL. --target editor only
                           supports --check (the golden is a fixed M1 artifact this
                           harness must never write) and additionally lets
                           https://esm.sh/** reach the live network — CodeMirror's
                           buildless module graph has no local/fixture form, and
                           every other editor/e2e suite in this repo (conftest.py,
                           run_browser_tests.py) already accepts that exception;
                           it never touches the render pipeline's own inputs and is
                           excluded from the hermeticity (live-request) failure
                           check below, though it IS printed in the summary.

DETERMINISM / HERMETICITY
    * Fresh ``browser.new_context()`` per entry => no localStorage PAT carry-over.
    * A route audit fails the run if any request escapes to the live internet
      (outside --record-fixtures) or if a required jsdelivr fixture is missing.
    * We capture the pre-JS ``srcdoc`` ATTRIBUTE STRING, never the live iframe DOM
      (viewer JS mutates the DOM; the attribute is what the renderer produced).

See docs/editor-plan.md (WP-1.1, risk R-2) and docs/editor-spec.md §9 M1.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as _dt
import difflib
import functools
import http.server
import json
import socket
import sys
import threading
import time as _time
import urllib.parse
from pathlib import Path

# ── Repo layout ──────────────────────────────────────────────────────────────
# Serve repo-content routes from the LOCAL WORKING TREE (this worktree root) so a
# local edit to e.g. _includes/embed/image.html is reflected without a rebuild.
REPO_ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = REPO_ROOT / "_site"
RENDER_DIR = REPO_ROOT / "tests" / "render"
CORPUS_PATH = RENDER_DIR / "corpus.json"
FIXTURES_DIR = RENDER_DIR / "fixtures" / "cdn"
GOLDEN_DIR = RENDER_DIR / "golden"

OWNER = "rsnyder"
REPO = "storykit-starter"
REF = "main"

# Fixed instant for page.clock — any stable value works; pinned + UTC + en-US so
# the banner's toLocaleTimeString() is reproducible across machines.
FIXED_TIME = _dt.datetime(2026, 7, 6, 12, 0, 0, tzinfo=_dt.timezone.utc)

POLL_TIMEOUT_MS = 30000


# ── Local static server (serves _site) ───────────────────────────────────────
class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # silence access log
        pass


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    # Guard the explicit "not 4000" requirement (ephemeral range never hits it,
    # but be defensive).
    if port == 4000:
        return _free_port()
    return port


@contextlib.contextmanager
def serve_site(directory: Path):
    port = _free_port()
    handler = functools.partial(_QuietHandler, directory=str(directory))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        httpd.shutdown()
        httpd.server_close()


# ── Content helpers ──────────────────────────────────────────────────────────
def _content_type_for(path: str) -> str:
    if path.endswith(".js"):
        return "application/javascript; charset=utf-8"
    if path.endswith(".json"):
        return "application/json; charset=utf-8"
    if path.endswith(".css"):
        return "text/css; charset=utf-8"
    return "text/plain; charset=utf-8"


def _tree_file_bytes(repo_rel_path: str) -> bytes | None:
    # Reject traversal; resolve within REPO_ROOT.
    candidate = (REPO_ROOT / repo_rel_path).resolve()
    try:
        candidate.relative_to(REPO_ROOT)
    except ValueError:
        return None
    if candidate.is_file():
        return candidate.read_bytes()
    return None


class RouteAudit:
    """Tracks how each request was handled and enforces hermeticity."""

    def __init__(self, record_fixtures: bool):
        self.record_fixtures = record_fixtures
        self.served_tree = 0        # github api / raw served from local tree
        self.tree_404 = 0           # local tree miss -> GitHub-shaped 404
        self.served_fixture = 0     # jsdelivr served from committed fixture
        self.recorded_fixture = 0   # jsdelivr captured live (record mode only)
        self.aborted = 0            # external subresources / non-main-frame
        self.continued_local = 0    # our own static server (localhost)
        self.blocked_hosts: set[str] = set()   # external hosts whose requests were aborted
        self.missing_fixtures: list[str] = []  # jsdelivr fixture absent in check/capture
        self.esm_live = 0           # --target editor only: esm.sh module graph (documented exception)

    def summary(self) -> str:
        extra = f" esm={self.esm_live}" if self.esm_live else ""
        return (
            f"tree={self.served_tree} tree404={self.tree_404} "
            f"fixture={self.served_fixture} recorded={self.recorded_fixture} "
            f"localhost={self.continued_local} aborted={self.aborted}{extra}"
        )

    def live_request_count(self) -> int:
        """Requests that actually reached the internet.

        Every request the page makes is intercepted: the catch-all route aborts
        anything not addressed to our localhost static server, and the specific
        routes fulfill from the local tree / fixtures. The ONLY code path that
        performs a real network request is ``route.fetch()`` in the jsdelivr
        handler, which increments ``recorded_fixture`` and is reachable only
        under --record-fixtures. So outside record mode this must be 0 — the
        run fails otherwise.
        """
        return self.recorded_fixture


def install_routes(page, audit: RouteAudit):
    main_frame = page.main_frame

    # Registered FIRST so it is checked LAST (Playwright evaluates most-recently
    # registered routes first). Everything not matched by a specific route below
    # lands here: localhost -> our static server; anything else -> aborted.
    def catch_all(route):
        url = route.request.url
        host = urllib.parse.urlparse(url).hostname or ""
        if host in ("127.0.0.1", "localhost"):
            audit.continued_local += 1
            route.continue_()
        else:
            audit.aborted += 1
            audit.blocked_hosts.add(host)
            route.abort()

    page.route("**/*", catch_all)

    # a. GitHub Contents API -> local working tree as base64 JSON.
    def github_api(route):
        req = route.request
        if req.frame != main_frame:
            audit.aborted += 1
            route.abort()
            return
        parsed = urllib.parse.urlparse(req.url)
        # /repos/<owner>/<repo>/contents/<path>
        marker = "/contents/"
        idx = parsed.path.find(marker)
        rel = urllib.parse.unquote(parsed.path[idx + len(marker):]) if idx >= 0 else ""
        data = _tree_file_bytes(rel) if rel else None
        if data is not None:
            audit.served_tree += 1
            body = json.dumps({
                "path": rel,
                "encoding": "base64",
                "content": base64.b64encode(data).decode("ascii"),
            })
            route.fulfill(status=200, content_type="application/json; charset=utf-8",
                          body=body)
        else:
            audit.tree_404 += 1
            route.fulfill(status=404, content_type="application/json; charset=utf-8",
                          body=json.dumps({"message": "Not Found"}))

    page.route(
        f"https://api.github.com/repos/{OWNER}/{REPO}/contents/**",
        github_api,
    )

    # b. raw.githubusercontent.com -> local working tree (plain text).
    def github_raw(route):
        req = route.request
        if req.frame != main_frame:
            audit.aborted += 1
            route.abort()
            return
        parsed = urllib.parse.urlparse(req.url)
        prefix = f"/{OWNER}/{REPO}/{REF}/"
        rel = urllib.parse.unquote(parsed.path[len(prefix):]) if parsed.path.startswith(prefix) else ""
        data = _tree_file_bytes(rel) if rel else None
        if data is not None:
            audit.served_tree += 1
            route.fulfill(status=200, content_type=_content_type_for(rel), body=data)
        else:
            audit.tree_404 += 1
            route.fulfill(status=404, content_type="text/plain", body="Not Found")

    page.route("https://raw.githubusercontent.com/**", github_raw)

    # c. cdn.jsdelivr.net -> committed fixtures (npm libs + Chirpy gem files).
    def jsdelivr(route):
        req = route.request
        # Only the main frame (the renderer) needs jsdelivr; any child-frame
        # (iframe srcdoc) jsdelivr request is a rendered-content subresource we
        # deliberately drop.
        if req.frame != main_frame:
            audit.aborted += 1
            route.abort()
            return
        parsed = urllib.parse.urlparse(req.url)
        rel = parsed.path.lstrip("/")  # e.g. npm/js-yaml@4.3.0/dist/js-yaml.min.js
        fixture = FIXTURES_DIR / rel
        if fixture.is_file():
            audit.served_fixture += 1
            route.fulfill(status=200, content_type=_content_type_for(rel),
                          body=fixture.read_bytes())
            return
        if audit.record_fixtures:
            resp = route.fetch()  # live request — allowed only in record mode
            body = resp.body()
            fixture.parent.mkdir(parents=True, exist_ok=True)
            fixture.write_bytes(body)
            audit.recorded_fixture += 1
            route.fulfill(response=resp)
            print(f"    recorded fixture: {rel} ({len(body)} bytes)")
            return
        # Non-record mode with a missing fixture: do NOT silently corrupt the
        # render — record the miss and 404 so the run fails loudly.
        audit.missing_fixtures.append(rel)
        route.fulfill(status=404, content_type="text/plain", body="missing fixture")

    page.route("https://cdn.jsdelivr.net/**", jsdelivr)


def install_editor_extra_routes(page, audit: RouteAudit):
    """--target editor only: on top of install_routes' tree/fixture/abort
    routes, let esm.sh's live CDN through for the editor's own CM6 module
    graph (see the file header TARGETS section for why this is an accepted,
    tracked, non-hermetic exception rather than a fixture set — it is the
    editor app shell loading, not a render-pipeline input, and every other
    editor test suite in this repo already takes the same live-esm.sh path).
    Registered AFTER install_routes so Playwright (LIFO route matching)
    checks this — more specific — route before the catch-all abort.
    """
    main_frame = page.main_frame

    def esm_passthrough(route):
        req = route.request
        if req.frame != main_frame:
            audit.aborted += 1
            route.abort()
            return
        audit.esm_live += 1
        route.continue_()

    page.route("https://esm.sh/**", esm_passthrough)


# ── Capture one corpus entry ─────────────────────────────────────────────────
def capture_entry(browser, base_url: str, entry: dict, record_fixtures: bool):
    payload = {"o": OWNER, "r": REPO, "ref": REF, "p": entry["path"]}
    hash_str = urllib.parse.quote(json.dumps(payload, separators=(",", ":")))
    url = f"{base_url}/preview/index.html#{hash_str}"

    context = browser.new_context(locale="en-US", timezone_id="UTC")
    audit = RouteAudit(record_fixtures)
    try:
        page = context.new_page()
        # Freeze Date before any page script runs -> deterministic banner
        # timestamp and site.time / dateless page.date fallbacks.
        page.clock.set_fixed_time(FIXED_TIME)
        install_routes(page, audit)

        page.goto(url, wait_until="domcontentloaded", timeout=POLL_TIMEOUT_MS)

        frame_el = page.locator("#__preview-frame")
        srcdoc = _poll_srcdoc(page, frame_el)
        return srcdoc, audit
    finally:
        context.close()


def capture_entry_editor(browser, base_url: str, entry: dict, record_fixtures: bool):
    """--target editor: drive editor/index.html's real UI/store to reproduce a
    corpus entry's preview, then capture the resulting `<iframe class="pv-frame">`
    srcdoc for a byte-compare against the SAME golden `capture_entry` (the
    preview/index.html path) produces it for.

    DRIVING ROUTE (documented per the WP-3.4 brief's "how you drive the UI"
    obligation): editor/doclist.js's "+ New" form only takes a title and always
    assigns TODAY's date in the generated `_posts/<yyyy-mm-dd>-<slug>.md` path —
    there is no UI control that sets an arbitrary `path` and pastes a large
    Markdown buffer in one atomic step. Rather than fight the UI (paste + a
    second "Rename path" round-trip, both real controls but slower and no more
    faithful), this calls the exact same entry points a click would —
    `app.modules.store.docs.create(...)` (the identical store call
    doclist.js's New Post form makes, just with an explicit `path`),
    `app.openDoc(id)` (the exact function doclist's onOpen callback invokes),
    and `app.setMode('preview')` (the exact function the segmented-control
    button's click handler invokes) — from `page.evaluate`, via a dynamic
    `import('/editor/app.js')` that resolves to the SAME module singleton the
    page's own `<script type="module" src="./app.js">` already instantiated
    (proven pattern: tests/e2e/test_m2_persistence.py's `_read_store_docs`).
    Everything downstream of that (mode:changed -> preview.render() -> context
    build -> renderPost() -> srcdoc write) runs exactly as it would from a real
    click, per docs/editor-plan.md WP-3.4 wiring.
    """
    path = entry["path"]
    data = _tree_file_bytes(path)
    if data is None:
        raise RuntimeError(f"corpus source missing in working tree: {path}")
    content = data.decode("utf-8")

    context = browser.new_context(locale="en-US", timezone_id="UTC")
    audit = RouteAudit(record_fixtures)
    try:
        page = context.new_page()
        page.clock.set_fixed_time(FIXED_TIME)
        install_routes(page, audit)
        install_editor_extra_routes(page, audit)

        page.goto(f"{base_url}/editor/index.html", wait_until="load", timeout=POLL_TIMEOUT_MS)

        # App booted: doclist.createDocList() has enabled #new-doc (same signal
        # tests/e2e/conftest.py's _wait_booted uses).
        page.wait_for_selector("#new-doc:not([disabled])", timeout=POLL_TIMEOUT_MS)

        page.evaluate(
            """async ({ content, path }) => {
                const app = await import('/editor/app.js');
                const rec = await app.modules.store.docs.create({
                    title: 'Render-regression fixture', path, content,
                });
                await app.openDoc(rec.id);
                app.setMode('preview');
            }""",
            {"content": content, "path": path},
        )

        frame_el = page.locator("#preview-mount iframe.pv-frame")
        frame_el.wait_for(state="attached", timeout=POLL_TIMEOUT_MS)
        srcdoc = _poll_srcdoc(page, frame_el)
        return srcdoc, audit
    finally:
        context.close()


def _poll_srcdoc(page, frame_el) -> str:
    deadline = _time.monotonic() + POLL_TIMEOUT_MS / 1000
    last = ""
    while _time.monotonic() < deadline:
        srcdoc = frame_el.get_attribute("srcdoc") or ""
        # The renderer writes srcdoc exactly once at completion (preview/index.html:1257).
        # A full document starts with a doctype/<html>; error placeholders are tiny.
        if srcdoc and len(srcdoc) > 200 and "<html" in srcdoc[:400].lower():
            return srcdoc
        last = srcdoc
        page.wait_for_timeout(100)
    badge = ""
    status = ""
    with contextlib.suppress(Exception):
        badge = page.locator("#pb-badge").text_content() or ""
        status = page.locator("#pb-status").text_content() or ""
    raise RuntimeError(
        f"srcdoc never populated (badge={badge!r} status={status!r} "
        f"last_len={len(last)})"
    )


# ── Corpus / mode drivers ────────────────────────────────────────────────────
def load_corpus(only: str | None) -> list[dict]:
    corpus = json.loads(CORPUS_PATH.read_text())["entries"]
    if only:
        wanted = {s.strip() for s in only.split(",")}
        corpus = [e for e in corpus if e["slug"] in wanted]
        missing = wanted - {e["slug"] for e in corpus}
        if missing:
            sys.exit(f"--only: unknown slug(s): {', '.join(sorted(missing))}")
    return corpus


def golden_path(slug: str) -> Path:
    return GOLDEN_DIR / f"{slug}.html"


def run(args) -> int:
    from playwright.sync_api import sync_playwright

    corpus = load_corpus(args.only)
    if not corpus:
        sys.exit("empty corpus")

    mode = ("record-fixtures" if args.record_fixtures else
            "capture" if args.capture else "check")
    print(f"mode={mode}  target={args.target}  entries={len(corpus)}  repo_root={REPO_ROOT}")

    if args.record_fixtures or args.capture:
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []
    all_missing_fixtures: set[str] = set()
    all_blocked_hosts: set[str] = set()
    live_requests = 0
    esm_live_total = 0
    capture_fn = capture_entry_editor if args.target == "editor" else capture_entry
    entry_page = "editor/index.html" if args.target == "editor" else "preview/index.html"

    with contextlib.ExitStack() as stack:
        if args.url:
            base_url = args.url.rstrip("/")
            print(f"server: using --url {base_url}")
        else:
            if not (SITE_DIR / entry_page).is_file():
                sys.exit(f"built site missing at {SITE_DIR}/{entry_page} — "
                         f"run `bundle exec jekyll build` first")
            base_url = stack.enter_context(serve_site(SITE_DIR))
            print(f"server: serving {SITE_DIR} at {base_url}")

        pw = stack.enter_context(sync_playwright())
        launch_kwargs = {"headless": True}
        if args.executable_path:
            launch_kwargs["executable_path"] = args.executable_path
        browser = stack.enter_context(_browser(pw, launch_kwargs))

        for entry in corpus:
            slug = entry["slug"]
            try:
                srcdoc, audit = capture_fn(browser, base_url, entry,
                                           args.record_fixtures)
            except Exception as exc:  # report per entry, continue
                print(f"  [ERROR] {slug}: {exc}")
                failures.append(slug)
                continue

            all_missing_fixtures.update(audit.missing_fixtures)
            all_blocked_hosts.update(audit.blocked_hosts)
            live_requests += audit.live_request_count()
            esm_live_total += audit.esm_live

            data = srcdoc.encode("utf-8")
            gp = golden_path(slug)

            if args.record_fixtures:
                print(f"  [record] {slug}: {audit.summary()}")
                # record-fixtures also writes goldens so a single command
                # bootstraps a fresh corpus.
                gp.write_bytes(data)
            elif args.capture:
                gp.write_bytes(data)
                print(f"  [capture] {slug}: {len(data)} bytes  ({audit.summary()})")
            else:  # check
                if not gp.is_file():
                    print(f"  [FAIL] {slug}: no golden at {gp}")
                    failures.append(slug)
                    continue
                golden = gp.read_bytes()
                if golden == data:
                    print(f"  [ok]   {slug}: {len(data)} bytes  ({audit.summary()})")
                else:
                    print(f"  [FAIL] {slug}: srcdoc differs from golden")
                    _print_diff(golden, data, slug)
                    failures.append(slug)

    # ── Hermeticity assertions ───────────────────────────────────────────────
    # Route audit: every request was intercepted. External hosts were hard-
    # aborted (never contacted); live fetches happen only via --record-fixtures.
    if all_blocked_hosts:
        print(f"\nroute audit: blocked external hosts (aborted, never contacted): "
              f"{', '.join(sorted(all_blocked_hosts))}")
    if esm_live_total:
        print(f"\nnote: {esm_live_total} live esm.sh request(s) — --target editor's "
              f"documented, tracked exception (editor app-shell module graph, not a "
              f"render-pipeline input); excluded from the hermeticity check below.")
    exit_code = 0
    if live_requests and not args.record_fixtures:
        print(f"\n[HERMETIC FAIL] {live_requests} request(s) reached the live internet")
        exit_code = 1
    if all_missing_fixtures and not args.record_fixtures:
        print("\n[FIXTURE FAIL] missing jsdelivr fixtures (run --record-fixtures):")
        for m in sorted(all_missing_fixtures):
            print(f"    {m}")
        exit_code = 1
    if failures:
        verb = "captured with errors" if (args.capture or args.record_fixtures) else "MISMATCHED"
        print(f"\n{len(failures)} entr{'y' if len(failures)==1 else 'ies'} {verb}: "
              f"{', '.join(failures)}")
        exit_code = 1

    if exit_code == 0:
        outcome = ("recorded" if args.record_fixtures else
                   "captured" if args.capture else "match golden")
        if args.record_fixtures:
            net = f"{live_requests} live fixture request(s)"
        elif esm_live_total:
            net = f"zero render-pipeline live network ({esm_live_total} esm.sh module request(s))"
        else:
            net = "zero live network"
        print(f"\nOK — {len(corpus)} entr{'y' if len(corpus)==1 else 'ies'} "
              f"{outcome}, {net}.")
    return exit_code


@contextlib.contextmanager
def _browser(pw, launch_kwargs):
    browser = pw.chromium.launch(**launch_kwargs)
    try:
        yield browser
    finally:
        browser.close()


def _print_diff(golden: bytes, captured: bytes, slug: str, max_lines: int = 60):
    g = golden.decode("utf-8", "replace").splitlines(keepends=True)
    c = captured.decode("utf-8", "replace").splitlines(keepends=True)
    diff = difflib.unified_diff(g, c, fromfile=f"golden/{slug}.html",
                                tofile=f"captured/{slug}.html", n=2)
    shown = 0
    for line in diff:
        out = line if line.endswith("\n") else line + "\n"
        sys.stdout.write("      " + out)
        shown += 1
        if shown >= max_lines:
            sys.stdout.write(f"      … (diff truncated at {max_lines} lines)\n")
            break


def main(argv=None):
    p = argparse.ArgumentParser(description="Render-regression harness for preview/index.html")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--capture", action="store_true",
                   help="write goldens to tests/render/golden/")
    g.add_argument("--check", action="store_true",
                   help="byte-compare against goldens (default)")
    g.add_argument("--record-fixtures", action="store_true",
                   help="one-time: let cdn.jsdelivr.net through, save fixtures + goldens")
    p.add_argument("--only", metavar="SLUG",
                   help="restrict to corpus slug(s) (comma-separated); --target editor "
                        "defaults to 'monument-valley' when omitted")
    p.add_argument("--target", choices=["preview", "editor"], default="preview",
                   help="preview (default): drive preview/index.html (the M1 gate). "
                        "editor: drive editor/index.html's real UI (the M3 fidelity "
                        "proof — WP-3.4); --check only.")
    p.add_argument("--url", metavar="ORIGIN",
                   help="use an already-running server instead of serving _site")
    p.add_argument("--executable-path", metavar="PATH",
                   help="Chromium executable (defaults to Playwright's cached build)")
    args = p.parse_args(argv)
    if not (args.capture or args.record_fixtures):
        args.check = True
    if args.target == "editor":
        if args.capture or args.record_fixtures:
            sys.exit("--target editor only supports --check — the golden is a fixed "
                     "M1 artifact this harness must never write from the editor path.")
        if not args.only:
            args.only = "monument-valley"
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
