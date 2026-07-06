#!/usr/bin/env python3
"""Drift check between editor/viewer-catalog.js and _includes/embed/*.html.

Ground truth for a viewer's accepted attributes is every `include.<attr>`
usage in its `_includes/embed/<name>.html` template. Several embeds also
delegate final <iframe> emission to the shared `_includes/embed/_iframe.html`
partial, forwarding some of their own attributes (id, class, aspect, width,
height) through to it under the same names — those are resolved below so
that a passthrough attribute is credited to the embed that exposes it to
authors, even if it is only referenced by name inside a local Liquid
`assign` rather than inline at the `{% include embed/_iframe.html %}` call.

`editor/viewer-catalog.js` is not valid JSON on its own (it's an ES module),
but the `catalog` export is written as a strict JSON object literal
specifically so it can be extracted with a brace-matcher and parsed with
`json.loads` here, without a JS runtime (the dev machine has no Node.js;
see docs/editor-plan.md §0.6).

Exits 1 and lists missing/extra attributes per embed on drift; exits 0 when
the catalog and the templates agree. Mirrors the style of
tools/check_consistency.py.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CATALOG_JS = REPO / "editor" / "viewer-catalog.js"
EMBED_DIR = REPO / "_includes" / "embed"

ATTR_RE = re.compile(r"include\.([a-z_]+)")

# _iframe.html parameters that are themselves sourced from the caller's own
# `include.<attr>` (i.e. author-facing, forwarded 1:1 by name) rather than
# built/hardcoded by the calling embed (base_class, title, src are always
# computed or literal, never simply forwarded from an author attribute).
FORWARDABLE_PARAMS = {"id", "class", "aspect", "width", "height"}


def extract_catalog(js_text: str) -> dict:
    """Brace-match the `export const catalog = { ... };` object literal and
    parse it as JSON (see module docstring for why this works)."""
    m = re.search(r"export\s+const\s+catalog\s*=\s*", js_text)
    if not m:
        raise ValueError("could not find 'export const catalog = ' in viewer-catalog.js")
    start = js_text.index("{", m.end())
    depth = 0
    i = start
    in_string = False
    escape = False
    while i < len(js_text):
        c = js_text[i]
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
        else:
            if c == '"':
                in_string = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
        i += 1
    else:
        raise ValueError("unterminated catalog object literal in viewer-catalog.js")
    blob = js_text[start : i + 1]
    return json.loads(blob)


def resolve_local_var(embed_text: str, var_name: str) -> str | None:
    """Trace a bare identifier used as an _iframe.html argument back to the
    `include.<attr>` it was assigned from, e.g.
    `{%- assign aspect = include.aspect | default: 1.0 -%}` -> "aspect"."""
    m = re.search(
        rf"assign\s+{re.escape(var_name)}\s*=\s*include\.([a-z_]+)", embed_text
    )
    return m.group(1) if m else None


def find_iframe_call_attrs(embed_text: str) -> set[str]:
    """Extract the attribute names passed through the shared _iframe.html
    partial for a single embed file's `{% include embed/_iframe.html ... %}`
    call, resolving bare local-variable arguments back to their source
    `include.<attr>`."""
    m = re.search(
        r"include\s+embed/_iframe\.html(.*?)-%\}", embed_text, re.S
    )
    if not m:
        return set()
    call_body = m.group(1)
    forwarded: set[str] = set()
    for param, value in re.findall(r"([a-z_]+)\s*=\s*([^\s]+)", call_body):
        if param not in FORWARDABLE_PARAMS:
            continue
        value_m = re.match(r"include\.([a-z_]+)", value)
        if value_m:
            forwarded.add(value_m.group(1))
            continue
        # Bare identifier (e.g. a local `aspect` var) — trace it back.
        ident_m = re.match(r"[a-z_][a-z0-9_]*$", value)
        if ident_m:
            resolved = resolve_local_var(embed_text, value)
            if resolved:
                forwarded.add(resolved)
    return forwarded


def ground_truth_attrs() -> dict[str, set[str]]:
    """{"embed/<file>.html": {attr, ...}} for every embed except the shared
    _iframe.html partial, combining direct `include.<attr>` usages with
    resolved _iframe.html passthrough attributes."""
    truth: dict[str, set[str]] = {}
    for path in sorted(EMBED_DIR.glob("*.html")):
        if path.name == "_iframe.html":
            continue
        text = path.read_text()
        attrs = set(ATTR_RE.findall(text))
        attrs |= find_iframe_call_attrs(text)
        truth[f"embed/{path.name}"] = attrs
    return truth


def main() -> int:
    if not CATALOG_JS.exists():
        print(f"ERROR: {CATALOG_JS} does not exist")
        return 1
    if not EMBED_DIR.exists():
        print(f"ERROR: {EMBED_DIR} does not exist")
        return 1

    try:
        catalog = extract_catalog(CATALOG_JS.read_text())
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: could not parse catalog out of {CATALOG_JS}: {exc}")
        return 1

    truth = ground_truth_attrs()

    errors: list[str] = []

    missing_embeds = sorted(set(truth) - set(catalog))
    extra_embeds = sorted(set(catalog) - set(truth))
    for name in missing_embeds:
        errors.append(f"{name}: present in _includes/embed/ but missing from catalog")
    for name in extra_embeds:
        errors.append(f"{name}: present in catalog but no matching _includes/embed/ file")

    for name in sorted(set(truth) & set(catalog)):
        cat_attrs = set(catalog[name].get("attrs", {}).keys())
        true_attrs = truth[name]

        missing = sorted(true_attrs - cat_attrs)
        extra = sorted(cat_attrs - true_attrs)

        if missing:
            errors.append(
                f"{name}: missing from catalog: {', '.join(missing)}"
            )
        if extra:
            errors.append(
                f"{name}: extra in catalog (not referenced by the template): {', '.join(extra)}"
            )

    for e in errors:
        print(f"ERROR: {e}")
    if not errors:
        print("Viewer catalog is in sync with _includes/embed/*.html.")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
