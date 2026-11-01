#!/usr/bin/env python3
"""
Sanitize bundled woff2 fonts to eliminate browser font-metadata warnings.

Targets the warnings reported by Firefox (and occasionally Chrome) for the
fonts shipped in `server/static/fonts/`:

  * "downloadable font: Glyph bbox was incorrect"
      → caused by per-glyph or head-table bbox values that don't match the
        actual outlines. Fix: recompute every glyph's bbox and rebuild the
        head-table bbox from the union of glyph bboxes.

  * "Non-zero caretOffset but head.macStyle italic bit is not set"
  * "italicAngle != 0 but head.macStyle italic bit is not set"
      → italic-style flags out of sync across head.macStyle / OS/2.fsSelection
        / post.italicAngle / hhea.caretOffset. Fix: detect "italic" in the
        filename, derive a single italic boolean, set all flags consistently.

  * "empty gid <N> used as component in glyph <M>"
      → composite glyph references a glyph that contains no contours and no
        components (e.g. OrelegaOne's uni00A0 → space). Fix: drop the empty
        component reference; if the parent then has zero components, mark it
        as a true empty glyph.

The script overwrites each woff2 in place and reports the changes per file.
Idempotent: running twice is a no-op.

Run:
    python3 build/scripts/server/sanitize-fonts.py [--dir server/static/fonts]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import math

from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont


def is_italic_filename(name: str) -> bool:
    return "italic" in name.lower()


def _outline_bbox_raw(
    glyph, glyf
) -> tuple[int, int, int, int] | None:
    """True outline bbox of a glyf Glyph in its **own** coordinate space
    (without the lsb-vs-xMin shift that `font.getGlyphSet()[name].draw()`
    applies for horizontal layout).

    Includes quadratic/cubic curve extremes — this is what Firefox compares
    against the stored glyph bbox. fontTools' built-in `Glyph.recalcBounds`
    only uses control-point min/max and silently produces a too-small bbox
    for any glyph whose curves bulge past their on-curve points.
    """
    pen = BoundsPen(None)
    try:
        glyph.draw(pen, glyf)
    except Exception:
        return None
    if pen.bounds is None:
        return None
    x0, y0, x1, y1 = pen.bounds
    # OpenType bboxes are int16; round outward so the stored bbox always
    # *contains* the true outline.
    return (
        math.floor(x0),
        math.floor(y0),
        math.ceil(x1),
        math.ceil(y1),
    )


def fix_glyf_bboxes(font: TTFont) -> int:
    """Recompute each glyf glyph's bbox using the true outline bbox (curve
    extremes included). Also realigns hmtx.lsb to match xMin per OpenType
    spec (otherwise composite parents draw shifted, and Firefox warns).
    Returns count of glyphs whose bbox or lsb changed.
    """
    glyf = font.get("glyf")
    if glyf is None:
        return 0
    hmtx = font.get("hmtx")
    n_changed = 0
    for gname in font.getGlyphOrder():
        g = glyf[gname]
        if not hasattr(g, "xMin"):
            continue
        # Empty glyphs (no contours, no components) have no bbox to recompute.
        if g.numberOfContours == 0 and not getattr(g, "components", None):
            continue
        before_bbox = (g.xMin, g.yMin, g.xMax, g.yMax)
        bbox = _outline_bbox_raw(g, glyf)
        if bbox is None:
            continue
        bbox_changed = bbox != before_bbox
        if bbox_changed:
            g.xMin, g.yMin, g.xMax, g.yMax = bbox
        # Realign hmtx.lsb = xMin (OpenType invariant for horizontal glyphs).
        lsb_changed = False
        if hmtx is not None and gname in hmtx.metrics:
            advance, lsb = hmtx.metrics[gname]
            if lsb != g.xMin:
                hmtx.metrics[gname] = (advance, g.xMin)
                lsb_changed = True
        if bbox_changed or lsb_changed:
            n_changed += 1
    return n_changed


def fix_head_bbox(font: TTFont) -> bool:
    """Rebuild head.bbox from the union of all non-empty glyph bboxes.

    Works for both glyf and CFF/CFF2 fonts. Returns True if head was changed.
    """
    head = font.get("head")
    if head is None:
        return False
    # Compute actual bbox
    glyf = font.get("glyf")
    actual = None
    if glyf:
        xs = []
        for gname in font.getGlyphOrder():
            g = glyf[gname]
            if g.numberOfContours == 0 and not getattr(g, "components", None):
                continue
            if hasattr(g, "xMin"):
                xs.append((g.xMin, g.yMin, g.xMax, g.yMax))
        if xs:
            actual = (
                min(x[0] for x in xs),
                min(x[1] for x in xs),
                max(x[2] for x in xs),
                max(x[3] for x in xs),
            )
    else:
        cff = font.get("CFF ") or font.get("CFF2")
        if cff is not None:
            try:
                fb = cff.cff.topDictIndex[0].FontBBox
                actual = (int(fb[0]), int(fb[1]), int(fb[2]), int(fb[3]))
            except Exception:
                actual = None
    if actual is None:
        return False
    stored = (head.xMin, head.yMin, head.xMax, head.yMax)
    if stored == actual:
        return False
    head.xMin, head.yMin, head.xMax, head.yMax = actual
    return True


def fix_italic_flags(font: TTFont, italic: bool) -> list[str]:
    """Synchronize italic flags across head.macStyle / OS/2.fsSelection /
    post.italicAngle / hhea.caretOffset.

    Returns the list of fields changed.
    """
    changed: list[str] = []
    head = font.get("head")
    OS2 = font.get("OS/2")
    post = font.get("post")
    hhea = font.get("hhea")

    if head is not None:
        old_italic = bool(head.macStyle & 0x02)
        if italic and not old_italic:
            head.macStyle |= 0x02
            changed.append("head.macStyle.italic=1")
        elif not italic and old_italic:
            head.macStyle &= ~0x02
            changed.append("head.macStyle.italic=0")

    if OS2 is not None:
        old_italic = bool(OS2.fsSelection & 0x01)
        if italic and not old_italic:
            OS2.fsSelection |= 0x01
            # If marking italic, ensure 'regular' bit (0x40) is cleared
            OS2.fsSelection &= ~0x40
            changed.append("OS/2.fsSelection.italic=1")
        elif not italic and old_italic:
            OS2.fsSelection &= ~0x01
            changed.append("OS/2.fsSelection.italic=0")

    if post is not None:
        # If italic but italicAngle is 0, leave it (we don't know the slant).
        # If non-italic but italicAngle is non-zero, zero it out — Firefox
        # warns about this combination.
        if not italic and post.italicAngle != 0:
            post.italicAngle = 0.0
            changed.append("post.italicAngle=0")

    if hhea is not None:
        # If non-italic, hhea.caretOffset should be zero (otherwise Firefox
        # complains about caret-offset-without-italic-bit).
        if not italic and getattr(hhea, "caretOffset", 0) != 0:
            hhea.caretOffset = 0
            changed.append("hhea.caretOffset=0")

    return changed


def fix_empty_components(font: TTFont) -> list[str]:
    """Drop composite-component references whose target glyph is empty.

    Fixes the OrelegaOne "empty gid used as component" warning. Returns the
    list of edited parent glyph names.
    """
    glyf = font.get("glyf")
    if not glyf:
        return []
    edited: list[str] = []
    for gname in font.getGlyphOrder():
        g = glyf[gname]
        comps = getattr(g, "components", None)
        if not comps:
            continue
        kept = []
        dropped_any = False
        for comp in comps:
            tgt_name = comp.glyphName
            tgt = glyf[tgt_name]
            tgt_empty = (
                tgt.numberOfContours == 0
                and not getattr(tgt, "components", None)
            )
            if tgt_empty:
                dropped_any = True
                continue
            kept.append(comp)
        if dropped_any:
            edited.append(gname)
            if kept:
                g.components = kept
            else:
                # Composite became empty — convert to a true empty glyph.
                g.numberOfContours = 0
                if hasattr(g, "components"):
                    del g.components
    return edited


def sanitize_font(path: Path) -> dict:
    font = TTFont(str(path))
    # CRITICAL: stop fontTools from recomputing glyf/head bboxes on save.
    # Its built-in recalcBounds uses control-point min/max, which is exactly
    # the wrong thing here — Firefox compares stored bbox to the true outline
    # bbox (curve extremes included). We compute the correct values via
    # BoundsPen below and need them to survive serialization unchanged.
    font.recalcBBoxes = False

    n_glyf_bbox = fix_glyf_bboxes(font)
    head_changed = fix_head_bbox(font)
    italic = is_italic_filename(path.name)
    italic_changes = fix_italic_flags(font, italic)
    empty_comp = fix_empty_components(font)

    # If anything changed, save back.
    changed = bool(
        n_glyf_bbox or head_changed or italic_changes or empty_comp
    )
    if changed:
        font.flavor = "woff2"
        # Save to a temp file then move, to avoid corrupting on error.
        tmp = path.with_suffix(path.suffix + ".tmp")
        font.save(str(tmp))
        tmp.replace(path)

    return {
        "file": path.name,
        "changed": changed,
        "glyf_bbox_recalc": n_glyf_bbox,
        "head_bbox_fixed": head_changed,
        "italic_changes": italic_changes,
        "empty_components_dropped": empty_comp,
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--dir",
        action="append",
        help=(
            "Directory containing woff2 files. May be passed multiple times. "
            "Default: server/static/fonts plus client KaTeX dirs."
        ),
    )
    args = p.parse_args()

    if args.dir:
        dirs = [Path(d) for d in args.dir]
    else:
        dirs = [
            Path("server/static/fonts"),
            Path("client/frontends/static/admin/assets"),
            Path("client/frontends/static/web/assets"),
        ]

    n_total = 0
    n_changed = 0
    for root in dirs:
        if not root.is_dir():
            continue
        woffs = sorted(root.glob("*.woff2"))
        if not woffs:
            continue
        print(f"\n{root}/")
        for woff in woffs:
            n_total += 1
            try:
                res = sanitize_font(woff)
            except Exception as e:
                print(f"  {woff.name:42s} FAIL: {e}")
                continue
            if res["changed"]:
                n_changed += 1
                details = []
                if res["glyf_bbox_recalc"]:
                    details.append(f"glyf-bbox×{res['glyf_bbox_recalc']}")
                if res["head_bbox_fixed"]:
                    details.append("head-bbox")
                if res["italic_changes"]:
                    details.append(
                        "italic[" + ",".join(res["italic_changes"]) + "]"
                    )
                if res["empty_components_dropped"]:
                    details.append(
                        f"empty-components×{len(res['empty_components_dropped'])}"
                    )
                print(f"  {woff.name:42s} fixed: {'; '.join(details)}")
            else:
                print(f"  {woff.name:42s} clean")

    print()
    print(f"Sanitized {n_changed}/{n_total} font files.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
