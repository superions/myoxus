#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Prepare full, static RIBBI faces from the bundled variable fonts for Office.

Run after fetching fonts, before export-theme-catalog.mjs. No font conversion
runs in an export request. All non-weight axes use their source defaults.
"""

import hashlib
import json
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[3]
FONTS = ROOT / "server/static/fonts"


def materialize(manifest):
    for family in manifest["families"]:
        ttf = family["ttf"]
        variable = (ttf.get("vf") or {}).get("all", [])
        # Existing static upstream faces already carry their RIBBI metadata.
        if not variable:
            continue
        # Static conversions are distributed with the server too. Respect RFNs
        # declared in the copyright preamble; keep attribution/license names.
        preamble = (FONTS / family["license"]).read_text().split("This Font Software")[0]
        word_family = family["name"]
        if "reserved font name" in preamble.lower():
            word_family = "Document " + hashlib.sha256(family["name"].encode()).hexdigest()[:10]
        cuts = []
        for source in variable:
            for weight in (400, 700):
                with TTFont(FONTS / source["file"], recalcTimestamp=False) as font:
                    if font["OS/2"].fsType & 0x0206:
                        raise ValueError(f"{source['file']}: editable outline embedding is forbidden")
                    axes = {axis.axisTag: axis.defaultValue for axis in font["fvar"].axes}
                    axis = next((axis for axis in font["fvar"].axes if axis.axisTag == "wght"), None)
                    if axis is None or not axis.minValue <= weight <= axis.maxValue:
                        continue
                    axes["wght"] = weight
                    face = instantiateVariableFont(font, axes, inplace=True)
                    italic = source["style"] == "italic"
                    bold = weight == 700
                    style = (
                        "Bold Italic" if bold and italic else
                        "Bold" if bold else "Italic" if italic else "Regular"
                    )
                    # Office links four faces through legacy family/subfamily names,
                    # not the variable font's named-instance metadata.
                    names = face["name"]
                    values = {
                        1: word_family, 2: style,
                        3: source["sha256"][:16] + ";" + word_family + ";" + style,
                        4: f"{word_family} {style}",
                        6: word_family.replace(" ", "") + "-" + style.replace(" ", ""),
                        16: word_family, 17: style,
                    }
                    for name_id, value in values.items():
                        names.removeNames(nameID=name_id)
                        names.setName(value, name_id, 3, 1, 0x409)
                        names.setName(value, name_id, 1, 0, 0)
                    face["OS/2"].usWeightClass = weight
                    face["OS/2"].fsSelection = (
                        (face["OS/2"].fsSelection & ~0x61) | int(italic)
                        | (0x20 if bold else 0) | (0x40 if not bold and not italic else 0)
                    )
                    face["head"].macStyle = (face["head"].macStyle & ~3) | int(bold) | (2 if italic else 0)
                    target = source["file"].removesuffix("-vf.ttf") + f"-word-{weight}.ttf"
                    face.save(FONTS / target)
                data = (FONTS / target).read_bytes()
                cuts.append({
                    "file": target, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                    "weight": weight, "style": source["style"], "upstream": source["upstream"],
                })
        # The existing static asset projection, audit and packaging consume these.
        ttf["static"] = [entry for entry in ttf.get("static", []) if "-word-" not in entry["file"]] + cuts


if __name__ == "__main__":
    path = FONTS / "manifest.json"
    manifest = json.loads(path.read_text())
    materialize(manifest)
    path.write_text(json.dumps(manifest, indent=2) + "\n")
