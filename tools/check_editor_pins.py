#!/usr/bin/env python3
"""Validate the editor's import map (docs/editor-plan.md §0.4, risk R-3).

The editor is buildless: every dependency loads from esm.sh at an EXACT pinned
version via the import map in editor/index.html. This check enforces the three
invariants that keep that safe, and is wired into CI by WP-1.3:

  (a) EXACT PINS — every import-map entry resolves its own package to a full
      X.Y.Z version (no ^/~/x ranges, no missing version).
  (b) REGISTERED — every pinned package@version appears in the
      "Editor (import map)" section of docs/dependencies.md.
  (c) SINGLE INSTANCE — @codemirror/state and @lezer/common each appear with
      EXACTLY ONE version across every URL in the map, including any versions
      embedded in `?deps=`/`?external=` query params. Two versions of either
      silently breaks every CodeMirror 6 extension.

Stdlib only (the dev machine has no Node.js). Exits 0 when clean, 1 with
specific messages on any violation.

Usage:
    python3 tools/check_editor_pins.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO / "editor" / "index.html"
DEPS_MD = REPO / "docs" / "dependencies.md"

# Packages whose duplication is the R-3 failure mode. Any others are still
# checked for exact-pin + registration, but only these two are held to the
# single-version invariant (they are the shared roots of the CM6/Lezer graph).
SINGLE_INSTANCE_PACKAGES = ("@codemirror/state", "@lezer/common")

# pkg@version, where pkg is either a scoped @scope/name or a bare name, and
# version starts with a semver core. Captures the version tail too so ranges
# and tags can be rejected.
PKG_VER_RE = re.compile(
    r"(?P<pkg>@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)"
    r"@(?P<ver>[\^~>=<]*[0-9A-Za-z.\-*]+)"
)
EXACT_VER_RE = re.compile(r"^\d+\.\d+\.\d+([.\-+][0-9A-Za-z.\-]+)?$")


def load_import_map(html: str) -> dict:
    """Extract and JSON-parse the <script type="importmap"> block."""
    m = re.search(
        r'<script[^>]*type=["\']importmap["\'][^>]*>(.*?)</script>',
        html,
        re.S | re.I,
    )
    if not m:
        raise ValueError('no <script type="importmap"> block found in editor/index.html')
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as exc:
        raise ValueError(f"import map is not valid JSON: {exc}") from exc
    imports = data.get("imports")
    if not isinstance(imports, dict) or not imports:
        raise ValueError('import map has no non-empty "imports" object')
    return imports


def all_pins_in(url: str) -> list[tuple[str, str]]:
    """Every (pkg, version) occurrence in a URL — path pin plus any embedded in
    ?deps=/?external= query params."""
    return [(m.group("pkg"), m.group("ver")) for m in PKG_VER_RE.finditer(url)]


def parse_registered(md: str) -> dict[str, str]:
    """{pkg: version} from the 'Editor (import map)' section table of
    docs/dependencies.md. Package/version cells may be wrapped in backticks."""
    lines = md.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.lstrip().startswith("#") and "editor" in line.lower() and "import map" in line.lower():
            start = i
            break
    if start is None:
        raise ValueError('no "Editor (import map)" section heading in docs/dependencies.md')

    registered: dict[str, str] = {}
    for line in lines[start + 1:]:
        stripped = line.lstrip()
        if stripped.startswith("#"):  # next section — stop
            break
        if not stripped.startswith("|"):
            continue
        cells = [c.strip().strip("`").strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        pkg, ver = cells[0], cells[1]
        if pkg.lower() in ("dependency", "package", "") or set(pkg) <= set("-: "):
            continue  # header / divider row
        registered[pkg] = ver
    if not registered:
        raise ValueError('the "Editor (import map)" section has no dependency rows')
    return registered


def main() -> int:
    if not INDEX_HTML.exists():
        print(f"ERROR: {INDEX_HTML} does not exist")
        return 1
    if not DEPS_MD.exists():
        print(f"ERROR: {DEPS_MD} does not exist")
        return 1

    try:
        imports = load_import_map(INDEX_HTML.read_text())
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 1
    try:
        registered = parse_registered(DEPS_MD.read_text())
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 1

    errors: list[str] = []
    map_pins: dict[str, str] = {}                    # pkg -> version (from the entry that owns it)
    versions_seen: dict[str, set[str]] = {}          # pkg -> {versions} across ALL urls

    for specifier, url in imports.items():
        if not isinstance(url, str):
            errors.append(f"{specifier}: import-map target is not a string")
            continue

        pins = all_pins_in(url)

        # (a) the entry must pin its OWN package to an exact version.
        own = [(p, v) for (p, v) in pins if p == specifier]
        if not own:
            errors.append(f"{specifier}: no version pin for this package found in its URL ({url})")
        else:
            _, ver = own[0]
            if not EXACT_VER_RE.match(ver):
                errors.append(
                    f"{specifier}: version '{ver}' is not an exact X.Y.Z pin "
                    f"(ranges/tags are forbidden — buildless map must be reproducible)"
                )
            else:
                map_pins[specifier] = ver

        # Record EVERY pin occurrence for the single-instance tally.
        for pkg, ver in pins:
            versions_seen.setdefault(pkg, set()).add(ver)

    # (b) registration in docs/dependencies.md.
    for pkg, ver in sorted(map_pins.items()):
        if pkg not in registered:
            errors.append(
                f"{pkg}: pinned to {ver} in the import map but not registered in "
                f'docs/dependencies.md ("Editor (import map)" section)'
            )
        elif registered[pkg] != ver:
            errors.append(
                f"{pkg}: import map pins {ver} but docs/dependencies.md registers "
                f"{registered[pkg]} — versions must match"
            )
    # Registered-but-absent-from-map: warn as an error too (stale registration).
    for pkg in sorted(set(registered) - set(map_pins)):
        errors.append(
            f"{pkg}: registered in docs/dependencies.md but not present as an exact "
            f"pin in the import map (stale entry?)"
        )

    # (c) single-instance invariant for the shared graph roots.
    for pkg in SINGLE_INSTANCE_PACKAGES:
        vers = versions_seen.get(pkg)
        if not vers:
            errors.append(
                f"{pkg}: not present anywhere in the import map — CodeMirror 6 "
                f"cannot resolve a single shared instance without it"
            )
        elif len(vers) > 1:
            errors.append(
                f"{pkg}: {len(vers)} versions across the import map "
                f"({', '.join(sorted(vers))}) — MUST be exactly one (risk R-3: "
                f"duplicate instances break every CM6 extension)"
            )

    if errors:
        print("Editor import-map check FAILED:")
        for e in errors:
            print(f"  ERROR: {e}")
        return 1

    print(
        f"Editor import map OK: {len(map_pins)} exact pins, all registered in "
        f"docs/dependencies.md; @codemirror/state and @lezer/common each single-version."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
