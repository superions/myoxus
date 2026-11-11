#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""
P-FONT-COVERAGE-03 — bundle TTF/VF + subsetted WOFF2 from Google Fonts.

Implements decisions 1, 2, 3, 8 from todo/pdf-refactoring.md
(Locked-In-Decisions, 2026-04-27):

  1. one WOFF2 per (family, weight, style, subset)
  2. variable font when upstream has one, else static instances
  3. body weights {400, 600, 700} × {normal, italic} = 6 (decoratives: 1)
  8. all binaries committed to git, manifest carries sha256 + upstream URL

Reads:  build/scripts/fonts/families.json
Writes: server/static/fonts/<files>
        server/static/fonts/licenses/<family>-OFL.txt
        server/static/fonts/manifest.json (schema v2)

Network sources:
  - https://raw.githubusercontent.com/google/fonts/main/ofl/<slug>/<file>
    (TTF / VF / OFL.txt — unmetered, no rate limit)
  - https://fonts.googleapis.com/css2?family=<id>:ital,wght@<pairs>
    (WOFF2 subset CSS — modern UA required)
  - https://fonts.gstatic.com/s/...                          (the WOFF2s)

The Google Fonts /download ZIP endpoint is deprecated and returns HTML;
the script reads upstream binaries from github.com/google/fonts instead.
The GitHub Contents API is rate-limited (60/h unauth) — we bypass it by
building direct raw URLs from a hard-coded VF_AXES table and probing
well-known static filenames.

Idempotent: files whose sha256 matches what's already on disk are skipped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

from fontTools.ttLib import TTFont

REPO_ROOT = Path(__file__).resolve().parents[3]
FONTS_DIR = REPO_ROOT / "server" / "static" / "fonts"
LICENSES_DIR = FONTS_DIR / "licenses"
MANIFEST_PATH = FONTS_DIR / "manifest.json"
FAMILIES_PATH = Path(__file__).with_name("families.json")

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

SUBSET_RANGES: dict[str, list[tuple[int, int]]] = {
    "latin":         [(0x0041, 0x007A)],
    "latin-ext":     [(0x0100, 0x024F)],
    "cyrillic":      [(0x0400, 0x04FF)],
    "cyrillic-ext":  [(0x0500, 0x052F), (0x1C80, 0x1C8F),
                      (0x2DE0, 0x2DFF), (0xA640, 0xA69F)],
    "greek":         [(0x0370, 0x03FF)],
    "greek-ext":     [(0x1F00, 0x1FFF)],
}

ANSI = {"red":"\033[31m","yellow":"\033[33m","green":"\033[32m",
        "cyan":"\033[36m","bold":"\033[1m","dim":"\033[2m","reset":"\033[0m"}

WEIGHT_TOKENS = [
    ("Thin", 100), ("ExtraLight", 200), ("Light", 300),
    ("Regular", 400), ("Medium", 500), ("SemiBold", 600),
    ("Bold", 700), ("ExtraBold", 800), ("Black", 900),
]

# VF axis tuple per upstream slug. Each VF family on google/fonts ships
# its variable axes encoded in the filename (e.g. `Inter[opsz,wght].ttf`).
# These were probed directly via curl on 2026-04-28 against
# raw.githubusercontent.com/google/fonts/main/ofl/<slug>/.
VF_AXES: dict[str, dict] = {
    "inter":          {"upright": "opsz,wght", "italic": "opsz,wght"},
    "roboto":         {"upright": "wdth,wght", "italic": "wdth,wght"},
    "opensans":       {"upright": "wdth,wght", "italic": "wdth,wght"},
    "montserrat":     {"upright": "wght",      "italic": "wght"},
    "sourcesans3":    {"upright": "wght",      "italic": "wght"},
    "nunito":         {"upright": "wght",      "italic": "wght"},
    "merriweather":   {"upright": "opsz,wdth,wght", "italic": "opsz,wdth,wght"},
    "lora":           {"upright": "wght",      "italic": "wght"},
    "sourceserif4":   {"upright": "opsz,wght", "italic": "opsz,wght"},
    "jetbrainsmono":  {"upright": "wght",      "italic": "wght"},
    "firacode":       {"upright": "wght",      "italic": None},  # no italic VF
    "sourcecodepro":  {"upright": "wght",      "italic": "wght"},
}

RAW_BASE = "https://raw.githubusercontent.com/google/fonts/main/ofl"


def upstream_static_filename(compact: str, token: str, italic: bool,
                             pattern: str | None) -> str:
    """Build the upstream TTF filename for one (weight, style) pair.

    Convention on github.com/google/fonts (verified 2026-04-28):
      `<Compact>-<Token>.ttf` for upright weights,
      `<Compact>-<Token>Italic.ttf` for italic weights — except weight 400
      italic, which drops the "Regular" prefix and is just `<Compact>-Italic.ttf`.

    Some families ship with non-standard upstream names (e.g. PT Serif's
    `PT_Serif-Web-<Token>.ttf`). They override via the per-family
    `upstream_static_pattern` field in families.json with literal placeholders
    `{token}` and `{italic_suffix}` (the latter is "Italic" or "").
    """
    # Weight-400 italic drops the "Regular" word both for the default and
    # for pattern-overridden families (verified on PT Serif: the upstream file
    # is `PT_Serif-Web-Italic.ttf`, not `…-RegularItalic.ttf`).
    if token == "Regular" and italic:
        token = ""
        italic_suffix = "Italic"
    else:
        italic_suffix = "Italic" if italic else ""
    if pattern is not None:
        result = pattern.format(token=token, italic_suffix=italic_suffix,
                                compact=compact)
        # Tidy a possible leftover "-{empty token}-" when the pattern uses
        # `{token}` and we cleared it for the italic-Regular case.
        return result.replace("--", "-")
    return f"{compact}-{token}{italic_suffix}.ttf" if token \
        else f"{compact}-{italic_suffix}.ttf"


def color(use: bool, n: str, t: str) -> str:
    return f"{ANSI[n]}{t}{ANSI['reset']}" if use else t


@dataclass
class FontFile:
    file: str
    sha256: str
    size: int
    upstream: str
    family: str
    weight: int
    style: str
    fmt: str
    role: str
    subset: str | None = None


@dataclass
class FamilyResult:
    name: str
    category: str
    decorative: bool
    license_file: str
    upstream_repo: str
    ttf_vf_files: list[FontFile] = field(default_factory=list)
    ttf_statics: list[FontFile] = field(default_factory=list)
    woff2_subsets: list[FontFile] = field(default_factory=list)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sanitize_font_payload(data: bytes) -> tuple[bytes, list[str]]:
    """Remove composite references to empty glyphs before an asset is stored.

    Firefox rejects these references even though other font consumers silently
    ignore them. Sanitizing the downloaded payload here keeps the committed
    binary and its manifest hash reproducible instead of repairing an asset
    after the manifest has already been generated.
    """
    font = TTFont(BytesIO(data))
    glyf = font.get("glyf")
    if glyf is None:
        return data, []

    edited: list[str] = []
    for glyph_name in font.getGlyphOrder():
        glyph = glyf[glyph_name]
        components = getattr(glyph, "components", None)
        if not components:
            continue

        kept = []
        for component in components:
            target = glyf[component.glyphName]
            target_empty = (
                target.numberOfContours == 0
                and not getattr(target, "components", None)
            )
            if not target_empty:
                kept.append(component)

        if len(kept) == len(components):
            continue

        edited.append(glyph_name)
        if kept:
            glyph.components = kept
        else:
            glyph.numberOfContours = 0
            del glyph.components

    if not edited:
        return data, []

    font.recalcBBoxes = False
    font.recalcTimestamp = False
    output = BytesIO()
    font.save(output)
    return output.getvalue(), edited


def http_get(url: str, *, timeout: int = 60, accept: str | None = None) -> bytes:
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    req = urllib.request.Request(url, headers=headers)
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError:
            raise  # don't retry semantic failures (404, rate limit, etc.)
        except urllib.error.URLError as exc:
            last = exc
            import time
            time.sleep(0.5 * (attempt + 1))
    assert last is not None
    raise last


def http_get_or_none(url: str, *, timeout: int = 60) -> bytes | None:
    """GET that returns None on 404 (used to probe optional static files)."""
    try:
        return http_get(url, timeout=timeout)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def google_dir_slug(google_id: str) -> str:
    return google_id.lower().replace("+", "")


def family_compact(google_id: str) -> str:
    """`Source+Sans+3` → `SourceSans3` — used in upstream filenames."""
    return google_id.replace("+", "")


def load_families() -> dict:
    with FAMILIES_PATH.open() as f:
        return json.load(f)


def parse_static_filename(family: str, name: str) -> tuple[int, str] | None:
    """`Lato-BoldItalic.ttf` → (700, 'italic'). Returns None on no match."""
    stem = Path(name).stem
    fam_compact = re.sub(r"\s+", "", family)
    if not stem.lower().startswith(fam_compact.lower() + "-"):
        return None
    suffix = stem[len(fam_compact) + 1:]
    style = "italic" if suffix.lower().endswith("italic") else "normal"
    weight_part = suffix[:-len("italic")] if style == "italic" and suffix.lower().endswith("italic") else suffix
    weight_part = weight_part.rstrip("-")
    if not weight_part:
        return None
    weight = None
    for token, w in WEIGHT_TOKENS:
        if weight_part == token:
            weight = w
            break
    if weight is None:
        return None
    return (weight, style)


def normalise_static_name(family: str, weight: int, style: str, fmt: str) -> str:
    name_map = {
        (100,"normal"):"thin",(200,"normal"):"extralight",(300,"normal"):"light",
        (400,"normal"):"regular",(500,"normal"):"medium",(600,"normal"):"semibold",
        (700,"normal"):"bold",(800,"normal"):"extrabold",(900,"normal"):"black",
        (100,"italic"):"thin-italic",(200,"italic"):"extralight-italic",
        (300,"italic"):"light-italic",(400,"italic"):"italic",
        (500,"italic"):"medium-italic",(600,"italic"):"semibold-italic",
        (700,"italic"):"bold-italic",(800,"italic"):"extrabold-italic",
        (900,"italic"):"black-italic",
    }
    return f"{slugify(family)}-{name_map[(weight, style)]}.{fmt}"


def normalise_vf_name(family: str, italic: bool, fmt: str) -> str:
    return f"{slugify(family)}{'-italic' if italic else ''}-vf.{fmt}"


def family_filename(family: str, weight: int, style: str,
                    subset: str | None, *, fmt: str) -> str:
    name_map = {
        (400,"normal"):"regular",(400,"italic"):"italic",
        (500,"normal"):"medium",(500,"italic"):"medium-italic",
        (600,"normal"):"semibold",(600,"italic"):"semibold-italic",
        (700,"normal"):"bold",(700,"italic"):"bold-italic",
        (300,"normal"):"light",(300,"italic"):"light-italic",
    }
    label = name_map.get((weight, style), f"{weight}{'i' if style=='italic' else ''}")
    base = f"{slugify(family)}-{label}"
    if subset:
        base += f"-{subset}"
    return f"{base}.{fmt}"


CSS_FONT_FACE_RE = re.compile(
    r"/\*\s*(?P<comment>[^*]+?)\s*\*/\s*"
    r"@font-face\s*\{(?P<body>[^}]+)\}",
    re.DOTALL,
)
SRC_URL_RE = re.compile(r"url\((?P<url>https?://[^)]+\.woff2)\)")
URANGE_RE = re.compile(r"unicode-range:\s*(?P<r>[^;]+);")
WEIGHT_RE = re.compile(r"font-weight:\s*(\d+)")
STYLE_RE  = re.compile(r"font-style:\s*([a-z]+)")


def parse_css_fontfaces(css: str) -> list[dict]:
    out: list[dict] = []
    for m in CSS_FONT_FACE_RE.finditer(css):
        body = m.group("body")
        url_m = SRC_URL_RE.search(body)
        if not url_m:
            continue
        wt = WEIGHT_RE.search(body)
        st = STYLE_RE.search(body)
        ur = URANGE_RE.search(body)
        out.append({
            "subset_label": m.group("comment").strip(),
            "url": url_m.group("url"),
            "weight": int(wt.group(1)) if wt else 400,
            "style": st.group(1) if st else "normal",
            "unicode_range": ur.group("r").strip() if ur else "",
        })
    return out


def unicode_range_subsets(unicode_range: str) -> list[str]:
    ranges: list[tuple[int, int]] = []
    for token in unicode_range.split(","):
        token = token.strip().lstrip("U+").lower()
        if not token:
            continue
        if "-" in token:
            a, b = token.split("-", 1)
            try:
                ranges.append((int(a, 16), int(b, 16)))
            except ValueError:
                continue
        else:
            try:
                v = int(token, 16)
                ranges.append((v, v))
            except ValueError:
                continue
    found: list[str] = []
    for label, target in SUBSET_RANGES.items():
        for tlo, thi in target:
            if any(lo <= thi and tlo <= hi for lo, hi in ranges):
                found.append(label)
                break
    return found


def css2_url(google_id: str, weights_styles: list[tuple[int, str]]) -> str:
    pairs = []
    for w, s in sorted(weights_styles, key=lambda x: (0 if x[1] == "normal" else 1, x[0])):
        pairs.append(f"{0 if s == 'normal' else 1},{w}")
    spec = google_id + ":ital,wght@" + ";".join(pairs)
    return "https://fonts.googleapis.com/css2?family=" + spec + "&display=swap"


def family_to_manifest(fr: FamilyResult) -> dict:
    def file_obj(ff: FontFile) -> dict:
        out = {
            "file": ff.file,
            "sha256": ff.sha256,
            "size": ff.size,
            "weight": ff.weight,
            "style": ff.style,
            "upstream": ff.upstream,
        }
        if ff.subset:
            out["subset"] = ff.subset
        return out

    coverage: list[str] = []
    for ff in fr.woff2_subsets:
        if ff.subset and ff.subset not in coverage:
            coverage.append(ff.subset)

    vf_obj = None
    if fr.ttf_vf_files:
        vfs = [file_obj(ff) for ff in fr.ttf_vf_files]
        primary = next((v for v in vfs if v["style"] == "normal"), vfs[0])
        vf_obj = {
            "file": primary["file"],
            "sha256": primary["sha256"],
            "size": primary["size"],
            "upstream": primary["upstream"],
            "all": vfs,
        }

    return {
        "name": fr.name,
        "category": fr.category,
        "decorative": fr.decorative,
        "license": f"licenses/{fr.license_file}",
        "upstream": fr.upstream_repo,
        "coverage": coverage,
        "ttf": {
            "vf": vf_obj,
            "static": [file_obj(ff) for ff in fr.ttf_statics],
        },
        "woff2_subsets": [file_obj(ff) for ff in fr.woff2_subsets],
    }


def write_if_changed(path: Path, data: bytes, *, dry: bool, use_color: bool) -> bool:
    new_sha = sha256_bytes(data)
    if path.exists():
        if sha256_bytes(path.read_bytes()) == new_sha:
            return False
    if dry:
        print(color(use_color, "dim", f"  would write {path.relative_to(REPO_ROOT)} ({len(data)} B)"))
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(color(use_color, "green", f"  wrote {path.relative_to(REPO_ROOT)} ({len(data)} B, sha={new_sha[:8]})"))
    return True


def fetch_family(fam: dict, root_cfg: dict, *, dry: bool, no_ttf: bool,
                 no_woff2: bool, use_color: bool) -> FamilyResult:
    name = fam["name"]
    google_id = fam["google_id"]
    is_decorative = bool(fam.get("decorative"))
    weights_styles: list[tuple[int, str]] = []
    if is_decorative:
        for w in fam.get("decorative_weights") or [400]:
            weights_styles.append((w, "normal"))
    elif fam.get("available_weights"):
        # Per-family override for upstreams that ship fewer cuts (e.g. PT Serif
        # has no SemiBold) — limits the matrix without producing 404 noise.
        for entry in fam["available_weights"]:
            weights_styles.append((entry["weight"], entry["style"]))
    else:
        for entry in root_cfg["body_weights"]:
            weights_styles.append((entry["weight"], entry["style"]))

    gh_slug = google_dir_slug(google_id)
    gh_repo_url = f"https://github.com/google/fonts/tree/main/ofl/{gh_slug}"
    fr = FamilyResult(
        name=name,
        category=fam["category"],
        decorative=is_decorative,
        license_file=fam["license_file"],
        upstream_repo=gh_repo_url,
    )

    if not no_ttf:
        print(color(use_color, "cyan", f"[{name}] raw ofl/{gh_slug}"))

        ofl_url = f"{RAW_BASE}/{gh_slug}/OFL.txt"
        lic_bytes = http_get_or_none(ofl_url)
        if lic_bytes is None:
            ofl_url = f"{RAW_BASE}/{gh_slug}/OFL.TXT"
            lic_bytes = http_get_or_none(ofl_url)
        if lic_bytes is not None:
            write_if_changed(LICENSES_DIR / fam["license_file"], lic_bytes,
                             dry=dry, use_color=use_color)
        else:
            print(color(use_color, "yellow", f"[{name}] no OFL.txt at {ofl_url}"))

        wants_vf = bool(fam.get("vf"))
        compact = family_compact(google_id)

        if wants_vf:
            axes = VF_AXES.get(gh_slug)
            if axes is None:
                raise RuntimeError(
                    f"[{name}] family marked vf=true but slug '{gh_slug}' "
                    f"is not in VF_AXES — add axis tuples to _fetch_fonts.py"
                )
            variants: list[tuple[bool, str]] = []
            if axes.get("upright"):
                variants.append((False, axes["upright"]))
            if axes.get("italic"):
                variants.append((True, axes["italic"]))
            for italic, axis_tuple in variants:
                # `Inter[opsz,wght].ttf` — brackets URL-encoded as %5B / %5D.
                upstream_name = f"{compact}{'-Italic' if italic else ''}[{axis_tuple}].ttf"
                upstream_url = f"{RAW_BASE}/{gh_slug}/{compact}{'-Italic' if italic else ''}%5B{axis_tuple}%5D.ttf"
                payload = http_get_or_none(upstream_url)
                if payload is None:
                    print(color(use_color, "yellow",
                                f"[{name}] VF not found at {upstream_url}"))
                    continue
                payload, sanitized_glyphs = sanitize_font_payload(payload)
                if sanitized_glyphs:
                    print(color(
                        use_color,
                        "green",
                        f"[{name}] sanitized empty composites: "
                        + ", ".join(sanitized_glyphs),
                    ))
                target = normalise_vf_name(name, italic, "ttf")
                write_if_changed(FONTS_DIR / target, payload, dry=dry, use_color=use_color)
                fr.ttf_vf_files.append(FontFile(
                    file=target, sha256=sha256_bytes(payload),
                    size=len(payload), upstream=upstream_url,
                    family=name, weight=400,
                    style="italic" if italic else "normal",
                    fmt="ttf", role="vf",
                ))
        else:
            pattern = fam.get("upstream_static_pattern")
            for weight, style in weights_styles:
                token = next((tok for tok, w in WEIGHT_TOKENS if w == weight), None)
                if token is None:
                    continue
                fname = upstream_static_filename(compact, token,
                                                 style == "italic", pattern)
                upstream_url = f"{RAW_BASE}/{gh_slug}/{fname}"
                payload = http_get_or_none(upstream_url)
                if payload is None:
                    print(color(use_color, "yellow",
                                f"[{name}] static not found: {fname}"))
                    continue
                payload, sanitized_glyphs = sanitize_font_payload(payload)
                if sanitized_glyphs:
                    print(color(
                        use_color,
                        "green",
                        f"[{name}] sanitized empty composites: "
                        + ", ".join(sanitized_glyphs),
                    ))
                target = normalise_static_name(name, weight, style, "ttf")
                write_if_changed(FONTS_DIR / target, payload,
                                 dry=dry, use_color=use_color)
                fr.ttf_statics.append(FontFile(
                    file=target, sha256=sha256_bytes(payload),
                    size=len(payload), upstream=upstream_url,
                    family=name, weight=weight, style=style,
                    fmt="ttf", role="static",
                ))

    if not no_woff2:
        url = css2_url(google_id, weights_styles)
        print(color(use_color, "cyan", f"[{name}] css2 {url}"))
        try:
            css = http_get(url).decode("utf-8")
        except urllib.error.HTTPError as exc:
            if exc.code == 400:
                print(color(use_color, "yellow",
                            f"[{name}] css2 400 — falling back to per-weight requests"))
                css = ""
                for w, s in weights_styles:
                    try:
                        css += http_get(css2_url(google_id, [(w, s)])).decode("utf-8") + "\n"
                    except urllib.error.HTTPError as e2:
                        print(color(use_color, "yellow",
                                    f"  weight {w} {s} not available ({e2.code})"))
            else:
                raise
        faces = parse_css_fontfaces(css)
        wanted_subsets = fam.get("subsets") or (
            root_cfg["subsets_decorative"]
            if is_decorative
            else root_cfg["subsets_body"]
        )
        wanted_subsets_set = set(wanted_subsets)
        for face in faces:
            label = face["subset_label"]
            if label not in wanted_subsets_set:
                # Non-European subset (vietnamese, devanagari, ...) — skip.
                # Their unicode-range can intersect latin-ext etc., but the
                # CSS API's subset label is canonical. Mapping by the
                # intersection alone causes filename collisions.
                continue
            try:
                payload = http_get(face["url"])
            except urllib.error.URLError as exc:
                print(color(use_color, "red", f"[{name}] download {face['url']} failed: {exc}"))
                continue
            payload, sanitized_glyphs = sanitize_font_payload(payload)
            if sanitized_glyphs:
                print(color(
                    use_color,
                    "green",
                    f"[{name}] sanitized empty composites: "
                    + ", ".join(sanitized_glyphs),
                ))
            target = family_filename(name, face["weight"], face["style"],
                                     label, fmt="woff2")
            write_if_changed(FONTS_DIR / target, payload,
                             dry=dry, use_color=use_color)
            fr.woff2_subsets.append(FontFile(
                file=target, sha256=sha256_bytes(payload),
                size=len(payload), upstream=face["url"],
                family=name, weight=face["weight"], style=face["style"],
                fmt="woff2", role="subset", subset=label,
            ))
    return fr


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", action="append", default=[],
                    help="Restrict to family name (repeatable).")
    ap.add_argument("--no-ttf", action="store_true",
                    help="Skip TTF/VF GitHub downloads.")
    ap.add_argument("--no-woff2", action="store_true",
                    help="Skip WOFF2 CSS-API downloads.")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--no-manifest-write", action="store_true",
                    help="Do not (re)write manifest.json.")
    args = ap.parse_args()

    use_color = sys.stdout.isatty() and not args.no_color
    cfg = load_families()
    families = cfg["families"]
    if args.only:
        families = [f for f in families if f["name"] in args.only]
        if not families:
            print(color(use_color, "red", "--only matched zero families"), file=sys.stderr)
            return 2

    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    LICENSES_DIR.mkdir(parents=True, exist_ok=True)

    results: list[FamilyResult] = []
    failures: list[tuple[str, str]] = []
    for fam in families:
        try:
            results.append(fetch_family(
                fam, cfg, dry=args.dry_run,
                no_ttf=args.no_ttf, no_woff2=args.no_woff2,
                use_color=use_color,
            ))
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            failures.append((fam["name"], f"{type(exc).__name__}: {exc}"))
            print(color(use_color, "red", f"[{fam['name']}] FAIL: {exc}"))

    if not args.no_manifest_write and results and not args.dry_run:
        existing: dict[str, dict] = {}
        preview_fonts = []
        if MANIFEST_PATH.exists():
            try:
                prev = json.loads(MANIFEST_PATH.read_text())
                preview_fonts = prev.get("typst_preview_fonts", [])
                if isinstance(prev, dict) and isinstance(prev.get("families"), list):
                    existing = {e["name"]: e for e in prev["families"] if "name" in e}
            except (json.JSONDecodeError, KeyError):
                pass

        for fr in results:
            existing[fr.name] = family_to_manifest(fr)

        all_names = [f["name"] for f in cfg["families"]]
        ordered = [existing[n] for n in all_names if n in existing]
        manifest = {
            "schema_version": 2,
            "generated_by": "build/scripts/fonts/fetch-fonts.sh",
            "families": ordered,
        }
        if preview_fonts:
            manifest["typst_preview_fonts"] = preview_fonts
        # Keep Office static faces in the same approved asset inventory.
        import runpy
        runpy.run_path(str(Path(__file__).with_name("materialize-docx-fonts.py")))["materialize"](manifest)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
        print(color(use_color, "green", f"wrote {MANIFEST_PATH.relative_to(REPO_ROOT)}"))

    if failures:
        print()
        print(color(use_color, "red", f"FAIL — {len(failures)} families:"))
        for name, msg in failures:
            print(f"  - {name}: {msg}")
        return 1

    print()
    print(color(use_color, "green", f"OK — {len(results)} families processed"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
