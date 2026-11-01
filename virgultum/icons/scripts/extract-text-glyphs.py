#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Extract static typographic icon artwork from bundled OFL Inter fonts.

This script is intentionally not part of the normal icon build path. It is a
maintenance helper for updating src/text-glyphs.inter.json when the icon system
needs additional typographic symbols. The committed JSON keeps regular builds
Node-only and deterministic.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

REPO_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_DIR = Path(__file__).resolve().parents[1]
OUTPUT_PATH = PACKAGE_DIR / "src" / "text-glyphs.inter.json"
BOLD_FONT = REPO_ROOT / "server" / "static" / "fonts" / "inter-vf.ttf"
BOLD_ITALIC_FONT = REPO_ROOT / "server" / "static" / "fonts" / "inter-italic-vf.ttf"
BOLD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#"<>/'
BOLD_ITALIC_CHARS = "I"
WEIGHT = 700
NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def round_number(raw: str) -> str:
    value = round(float(raw), 2)
    if value == 0:
        value = 0
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text or "0"


def round_path(path_data: str) -> str:
    return NUMBER_RE.sub(lambda match: round_number(match.group(0)), path_data)


def rounded_bounds(bounds: tuple[float, float, float, float] | None) -> list[float]:
    if bounds is None:
        raise ValueError("empty glyph bounds")
    return [float(round_number(str(value))) for value in bounds]


def extract(font_path: Path, chars: str, weight: int) -> dict[str, object]:
    font = TTFont(font_path)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": weight}, inplace=False)
    glyph_set = font.getGlyphSet()
    cmap: dict[int, str] = {}
    for table in font["cmap"].tables:
        cmap.update(table.cmap)

    glyphs: dict[str, object] = {}
    for char in chars:
        glyph_name = cmap[ord(char)]
        glyph = glyph_set[glyph_name]
        path_pen = SVGPathPen(glyph_set)
        glyph.draw(path_pen)
        bounds_pen = BoundsPen(glyph_set)
        glyph.draw(bounds_pen)
        glyphs[char] = {
            "glyph": glyph_name,
            "d": round_path(path_pen.getCommands()),
            "bounds": rounded_bounds(bounds_pen.bounds),
            "unitsPerEm": font["head"].unitsPerEm,
        }
    return glyphs


def main() -> None:
    data = {
        "description": "Static text artwork for Myoxus/Virgultum UI icons. Extracted from local Inter variable fonts at wght 700; not a runtime font dependency.",
        "license": "Generated icon artwork is AGPL-3.0-or-later. Source font files are SIL OFL 1.1 bundled under server/static/fonts/.",
        "sources": {
            "bold": {
                "path": "server/static/fonts/inter-vf.ttf",
                "sha256": sha256(BOLD_FONT),
                "weight": WEIGHT,
            },
            "boldItalic": {
                "path": "server/static/fonts/inter-italic-vf.ttf",
                "sha256": sha256(BOLD_ITALIC_FONT),
                "weight": WEIGHT,
            },
        },
        "bold": extract(BOLD_FONT, BOLD_CHARS, WEIGHT),
        "boldItalic": extract(BOLD_ITALIC_FONT, BOLD_ITALIC_CHARS, WEIGHT),
    }
    OUTPUT_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
