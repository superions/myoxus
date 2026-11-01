#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""
P-FONT-COVERAGE-01: enumerate fonts in server/static/fonts/ and detect
which European Unicode subsets each font covers (latin / latin-ext /
cyrillic / cyrillic-ext / greek / greek-ext).

Outputs a coverage table by default. With --validate it also checks the
inventory against manifest.json:

  red FAIL  - file on disk without manifest entry
  red FAIL  - manifest entry without file on disk
  red FAIL  - sha256 mismatch (only checked if manifest entry has sha256)

Coverage gaps (body family without cyrillic OR greek) are *yellow*
notes by Decision 4 (lax body-picker, user choice).

Exit codes:
  0  - all OK (yellow notes are not a fail)
  1  - red fail (manifest sync issue)
  2  - usage / environment error
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

from fontTools.ttLib import TTFont

REPO_ROOT = Path(__file__).resolve().parents[3]
FONTS_DIR = REPO_ROOT / "server" / "static" / "fonts"
MANIFEST_PATH = FONTS_DIR / "manifest.json"
LICENSES_DIR = FONTS_DIR / "licenses"

# Google Fonts CSS API subset definitions, narrowed to the codepoint
# ranges that uniquely identify each subset. We test if the font has
# at least one codepoint in each range.
SUBSET_RANGES: dict[str, list[tuple[int, int]]] = {
    "latin": [(0x0041, 0x007A)],
    "latin-ext": [(0x0100, 0x024F)],
    "cyrillic": [(0x0400, 0x04FF)],
    "cyrillic-ext": [
        (0x0500, 0x052F),
        (0x1C80, 0x1C8F),
        (0x2DE0, 0x2DFF),
        (0xA640, 0xA69F),
    ],
    "greek": [(0x0370, 0x03FF)],
    "greek-ext": [(0x1F00, 0x1FFF)],
}

ANSI = {
    "red": "\033[31m",
    "yellow": "\033[33m",
    "green": "\033[32m",
    "cyan": "\033[36m",
    "bold": "\033[1m",
    "dim": "\033[2m",
    "reset": "\033[0m",
}


@dataclass
class FontEntry:
    file: str
    family: str = ""
    weight: int = 0
    style: str = ""
    fmt: str = ""
    subsets: list[str] = field(default_factory=list)
    glyph_count: int = 0
    sha256: str = ""
    size: int = 0
    error: str | None = None


def detect_subsets(font: TTFont) -> list[str]:
    cmap = font.getBestCmap() or {}
    if not cmap:
        return []
    cps = set(cmap.keys())
    found = []
    for name, ranges in SUBSET_RANGES.items():
        for lo, hi in ranges:
            if any(lo <= cp <= hi for cp in cps):
                found.append(name)
                break
    return found


def find_empty_component_references(font: TTFont) -> list[str]:
    glyf = font.get("glyf")
    if glyf is None:
        return []
    invalid: list[str] = []
    for glyph_name in font.getGlyphOrder():
        glyph = glyf[glyph_name]
        for component in getattr(glyph, "components", None) or []:
            target = glyf[component.glyphName]
            if (
                target.numberOfContours == 0
                and not getattr(target, "components", None)
            ):
                invalid.append(f"{glyph_name}->{component.glyphName}")
    return invalid


def inspect(path: Path) -> FontEntry:
    raw = path.read_bytes()
    entry = FontEntry(
        file=path.name,
        sha256=hashlib.sha256(raw).hexdigest(),
        size=len(raw),
        fmt=path.suffix.lstrip(".").lower(),
    )
    try:
        font = TTFont(path, lazy=True)
    except Exception as exc:
        entry.error = f"{type(exc).__name__}: {exc}"
        return entry

    name_table = font["name"]
    entry.family = name_table.getBestFamilyName() or "?"
    sub = (name_table.getBestSubFamilyName() or "Regular").lower()
    os2 = font.get("OS/2")
    entry.weight = int(os2.usWeightClass) if os2 else 400
    entry.style = "italic" if ("italic" in sub or "oblique" in sub) else "normal"
    entry.subsets = detect_subsets(font)
    entry.glyph_count = font["maxp"].numGlyphs
    invalid_components = find_empty_component_references(font)
    if invalid_components:
        entry.error = (
            "empty composite component references: "
            + ", ".join(invalid_components[:5])
        )
    return entry


def color(use: bool, name: str, txt: str) -> str:
    if not use:
        return txt
    return f"{ANSI[name]}{txt}{ANSI['reset']}"


def visible_len(s: str) -> int:
    out = s
    for v in ANSI.values():
        out = out.replace(v, "")
    return len(out)


def render_table(rows: list[FontEntry], use_color: bool, decoratives: set[str]) -> None:
    headers = ["file", "family", "wght", "style", "fmt", "subsets", "glyphs", "sha", "size"]
    table: list[list[str]] = []
    for r in rows:
        if r.error:
            table.append([
                r.file,
                color(use_color, "red", f"ERR: {r.error[:40]}"),
                "", "", r.fmt, "", "", r.sha256[:8], f"{r.size/1024:.1f}KB",
            ])
            continue
        is_decorative = r.family in decoratives
        subsets_disp = ",".join(r.subsets) if r.subsets else "-"
        if not is_decorative:
            missing_eur = []
            if "cyrillic" not in r.subsets:
                missing_eur.append("cyr")
            if "greek" not in r.subsets:
                missing_eur.append("grk")
            if missing_eur:
                subsets_disp = color(
                    use_color, "yellow", f"{subsets_disp} (no:{'+'.join(missing_eur)})"
                )

        table.append([
            r.file,
            r.family,
            str(r.weight),
            r.style,
            r.fmt,
            subsets_disp,
            str(r.glyph_count),
            r.sha256[:8],
            f"{r.size/1024:.1f}KB",
        ])

    widths = [len(h) for h in headers]
    for row in table:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], visible_len(cell))

    def render_row(cells: list[str]) -> str:
        parts = []
        for i, cell in enumerate(cells):
            pad = widths[i] - visible_len(cell)
            parts.append(cell + " " * pad)
        return "  ".join(parts)

    print(color(use_color, "bold", render_row(headers)))
    print(color(use_color, "dim", "  ".join("-" * w for w in widths)))
    for row in table:
        print(render_row(row))


def load_manifest() -> dict | list | None:
    if not MANIFEST_PATH.exists():
        return None
    return json.loads(MANIFEST_PATH.read_text())


def derive_decoratives(manifest) -> set[str]:
    """Read decorative families from manifest. Falls back to legacy
    'category' field for the old schema (display/handwriting = decorative)."""
    out: set[str] = set()
    if manifest is None:
        return out
    entries = manifest if isinstance(manifest, list) else manifest.get("families", [])
    for e in entries:
        if e.get("decorative") is True:
            out.add(e["name"])
            continue
        # Old schema fallback: display + handwriting are decorative.
        cat = e.get("category", "")
        if cat in ("display", "handwriting"):
            out.add(e["name"])
    return out


REQUIRED_FAMILY_FIELDS = ("name", "license", "coverage", "decorative")


def validate_schema_strict(entries: list[dict], use_color: bool) -> list[str]:
    """Enforce v2-schema invariants on every family entry.

    Returns a list of FAIL messages (empty when strict OK).
    """
    fails: list[str] = []
    for e in entries:
        name = e.get("name") or "<unnamed>"
        for fld in REQUIRED_FAMILY_FIELDS:
            if fld not in e:
                fails.append(f"family '{name}': missing required field '{fld}'")
        if "decorative" in e and not isinstance(e["decorative"], bool):
            fails.append(
                f"family '{name}': 'decorative' must be a bool, got "
                f"{type(e['decorative']).__name__}"
            )
        cov = e.get("coverage")
        if cov is not None and (not isinstance(cov, list) or not cov):
            fails.append(
                f"family '{name}': 'coverage' must be a non-empty list of subset names"
            )

        # Every file reference must carry sha256 in the new schema.
        ttf_block = e.get("ttf") or {}
        if isinstance(ttf_block, dict):
            vf = ttf_block.get("vf")
            if isinstance(vf, dict):
                all_vfs = vf.get("all") or []
                if not all_vfs and vf.get("file") and not vf.get("sha256"):
                    fails.append(f"family '{name}': ttf.vf '{vf['file']}' missing sha256")
                for inst in all_vfs:
                    if isinstance(inst, dict) and inst.get("file") and not inst.get("sha256"):
                        fails.append(
                            f"family '{name}': ttf.vf.all '{inst['file']}' missing sha256"
                        )
            elif isinstance(vf, str):
                fails.append(
                    f"family '{name}': ttf.vf '{vf}' is a bare filename "
                    f"(legacy schema); rewrite as object with sha256"
                )
            for inst in ttf_block.get("static") or []:
                if isinstance(inst, dict) and inst.get("file") and not inst.get("sha256"):
                    fails.append(
                        f"family '{name}': ttf.static '{inst['file']}' missing sha256"
                    )
        for sub in e.get("woff2_subsets") or []:
            if sub.get("file") and not sub.get("sha256"):
                fails.append(
                    f"family '{name}': woff2_subsets '{sub['file']}' missing sha256"
                )
        if e.get("file") and "ttf" not in e and "woff2_subsets" not in e:
            fails.append(
                f"family '{name}': legacy top-level 'file' field — rewrite as v2 schema"
            )
    return fails


def validate_license_files(entries: list[dict], use_color: bool) -> list[str]:
    """Check parity between licenses on disk and manifest references.

    Every `*-OFL.txt` (or `*-LICENSE.txt`) under licenses/ must be referenced
    by at least one family entry; every family `license` field must point
    at an existing file. Returns FAIL messages (empty on success).
    """
    fails: list[str] = []
    if not LICENSES_DIR.exists():
        fails.append(f"licenses dir missing: {LICENSES_DIR}")
        return fails

    disk_licenses = {
        p.name for p in LICENSES_DIR.iterdir()
        if p.is_file() and p.suffix.lower() == ".txt"
    }
    referenced: set[str] = set()
    for e in entries:
        lic = e.get("license")
        if not lic:
            fails.append(f"family '{e.get('name', '?')}': missing license field")
            continue
        # license is stored as "licenses/<file>.txt" — strip the dir prefix.
        rel = lic.split("/", 1)[-1] if "/" in lic else lic
        referenced.add(rel)
        if rel not in disk_licenses:
            fails.append(
                f"family '{e.get('name', '?')}': license '{lic}' missing on disk "
                f"(expected at {LICENSES_DIR / rel})"
            )

    orphan = sorted(disk_licenses - referenced)
    for f in orphan:
        fails.append(f"licenses/{f}: not referenced by any family in manifest.json")
    return fails


def validate_against_manifest(rows: list[FontEntry], use_color: bool) -> bool:
    """Returns True when validation passes."""
    manifest = load_manifest()
    if manifest is None:
        print(color(use_color, "red", f"FAIL: manifest missing at {MANIFEST_PATH}"))
        return False

    entries = manifest if isinstance(manifest, list) else manifest.get("families", [])

    schema_fails = validate_schema_strict(entries, use_color)
    preview_entries = [] if isinstance(manifest, list) else manifest.get("typst_preview_fonts", [])
    for entry in preview_entries:
        for field in ("file", "sha256", "source_url", "license", "license_id"):
            if not isinstance(entry.get(field), str) or not entry[field]:
                schema_fails.append(f"Typst preview font: missing {field}")
        digest = entry.get("sha256", "")
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            schema_fails.append(f"Typst preview font: invalid sha256 for {entry.get('file')}")
    license_fails = validate_license_files(entries + preview_entries, use_color)

    manifest_files: dict[str, dict] = {}
    for e in entries:
        # Schema v2: { ttf: { vf: {file, sha256, all: [...] }, static: [...] },
        #              woff2_subsets: [...] }
        ttf_block = e.get("ttf") or {}
        if isinstance(ttf_block, dict):
            vf = ttf_block.get("vf")
            if isinstance(vf, dict):
                # Prefer the "all" array (covers upright + italic VFs).
                all_vfs = vf.get("all")
                if isinstance(all_vfs, list) and all_vfs:
                    for inst in all_vfs:
                        if isinstance(inst, dict) and inst.get("file"):
                            manifest_files[inst["file"]] = {"sha256": inst.get("sha256")}
                elif vf.get("file"):
                    manifest_files[vf["file"]] = {"sha256": vf.get("sha256")}
            elif isinstance(vf, str):
                # Legacy/forward-compat: bare filename without metadata.
                manifest_files[vf] = {"sha256": None, "legacy": True}
            for inst in ttf_block.get("static") or []:
                if isinstance(inst, dict) and inst.get("file"):
                    manifest_files[inst["file"]] = {"sha256": inst.get("sha256")}
        for sub in e.get("woff2_subsets") or []:
            if sub.get("file"):
                manifest_files[sub["file"]] = {"sha256": sub.get("sha256")}
        # Old schema: top-level "file" field (no sha256).
        if e.get("file") and "ttf" not in e and "woff2_subsets" not in e:
            manifest_files[e["file"]] = {"sha256": None, "legacy": True}

    for entry in preview_entries:
        if entry.get("file") in manifest_files:
            schema_fails.append(f"Duplicate preview font: {entry['file']}")
        if entry.get("file"):
            manifest_files[entry["file"]] = {"sha256": entry.get("sha256")}

    disk_files = {r.file: r for r in rows}

    fail = False
    only_disk = sorted(set(disk_files) - set(manifest_files))
    only_manifest = sorted(set(manifest_files) - set(disk_files))

    if only_disk:
        fail = True
        print(color(use_color, "red", f"FAIL: {len(only_disk)} files on disk without manifest entry:"))
        for f in only_disk:
            print(f"  - {f}")
    if only_manifest:
        fail = True
        print(color(use_color, "red", f"FAIL: {len(only_manifest)} manifest entries without file:"))
        for f in only_manifest:
            print(f"  - {f}")

    sha_failed: list[tuple[str, str, str]] = []
    for fname, meta in manifest_files.items():
        expected = meta.get("sha256")
        if not expected or fname not in disk_files:
            continue
        got = disk_files[fname].sha256
        if got != expected:
            sha_failed.append((fname, expected, got))
    if sha_failed:
        fail = True
        print(color(use_color, "red", f"FAIL: {len(sha_failed)} sha256 mismatches:"))
        for fname, exp, got in sha_failed:
            print(f"  - {fname}\n      expected: {exp}\n      actual:   {got}")

    if schema_fails:
        fail = True
        print(color(use_color, "red", f"FAIL: {len(schema_fails)} manifest schema violations:"))
        for msg in schema_fails:
            print(f"  - {msg}")
    if license_fails:
        fail = True
        print(color(use_color, "red", f"FAIL: {len(license_fails)} license file issues:"))
        for msg in license_fails:
            print(f"  - {msg}")

    if not fail:
        print(color(use_color, "green", "manifest sync OK"))
    return not fail


def print_summary(rows: list[FontEntry], decoratives: set[str], use_color: bool) -> None:
    total_size = sum(r.size for r in rows if not r.error)
    err_count = sum(1 for r in rows if r.error)
    body_full_eur = sum(
        1 for r in rows
        if not r.error
        and r.family not in decoratives
        and "cyrillic" in r.subsets
        and "greek" in r.subsets
    )
    body_total = sum(
        1 for r in rows if not r.error and r.family not in decoratives
    )

    print()
    print(f"  total files:               {len(rows)}")
    print(f"  parse errors:              {err_count}")
    print(f"  total size:                {total_size/1024:.1f} KB ({total_size/(1024*1024):.2f} MB)")
    print(f"  decorative families:       {len(decoratives)}")
    print(
        f"  body files w/ cyr+grk:     {body_full_eur}/{body_total}"
        + ("" if body_total == 0 else f"  ({100*body_full_eur//body_total}%)")
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--validate", action="store_true",
                    help="Validate against manifest.json (file presence + sha256).")
    ap.add_argument("--json", action="store_true",
                    help="Emit JSON instead of a human table.")
    args = ap.parse_args()

    use_color = sys.stdout.isatty() and not args.no_color

    if not FONTS_DIR.exists():
        print(color(use_color, "red", f"fonts dir missing: {FONTS_DIR}"), file=sys.stderr)
        return 2

    files = sorted(
        p for p in FONTS_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in (".ttf", ".otf", ".woff2")
    )
    if not files:
        print(color(use_color, "red", f"no font files in {FONTS_DIR}"), file=sys.stderr)
        return 1

    rows = [inspect(p) for p in files]
    decoratives = derive_decoratives(load_manifest())

    if args.json:
        print(json.dumps(
            [r.__dict__ for r in rows], indent=2, ensure_ascii=False
        ))
        return 0

    render_table(rows, use_color, decoratives)
    print_summary(rows, decoratives, use_color)

    if args.validate:
        print()
        invalid_composites = [
            row for row in rows
            if row.error and row.error.startswith("empty composite component references:")
        ]
        if invalid_composites:
            print(color(
                use_color,
                "red",
                f"FAIL: {len(invalid_composites)} font files contain empty composite references:",
            ))
            for row in invalid_composites:
                print(f"  - {row.file}: {row.error}")
        manifest_ok = validate_against_manifest(rows, use_color)
        return 0 if manifest_ok and not invalid_composites else 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
