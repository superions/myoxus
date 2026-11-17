#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Materialize licensed renderer baseline and Unicode coverage fonts."""

import hashlib
import json
import sys
from pathlib import Path
from urllib.request import urlopen

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[3]
FONT_DIR = ROOT / "server/static/fonts"
SOURCE = "https://raw.githubusercontent.com/typst/typst-assets/ad8080d46d42fca909562572cfa14a86f00eb945/files/fonts/"
FILES = [
    "DejaVuSansMono-Bold.ttf", "DejaVuSansMono-BoldOblique.ttf",
    "DejaVuSansMono-Oblique.ttf", "DejaVuSansMono.ttf",
    "LibertinusSerif-Bold.otf", "LibertinusSerif-BoldItalic.otf",
    "LibertinusSerif-Italic.otf", "LibertinusSerif-Regular.otf",
    "LibertinusSerif-Semibold.otf", "LibertinusSerif-SemiboldItalic.otf",
    "NewCM10-Bold.otf", "NewCM10-BoldItalic.otf", "NewCM10-Italic.otf",
    "NewCM10-Regular.otf", "NewCMMath-Bold.otf", "NewCMMath-Book.otf",
    "NewCMMath-Regular.otf",
]

ofl = (FONT_DIR / "licenses/inter-OFL.txt").read_text()
ofl = ofl[ofl.index("SIL OPEN FONT LICENSE"):]
emoji_only = "--emoji-only" in sys.argv
if not emoji_only:
    with urlopen("https://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt", timeout=30) as response:
        gust = response.read().decode("utf-8")
    if "version 1.0" not in gust:
        raise RuntimeError("Unexpected GUST license document")

entries = [] if not emoji_only else [
    entry for entry in json.loads((FONT_DIR / "manifest.json").read_text())["typst_preview_fonts"]
    if entry["file"] != "noto-emoji-vf.ttf"
]
for original in ([] if emoji_only else FILES):
    filename = "typst-" + original
    url = SOURCE + original
    with urlopen(url, timeout=30) as response:
        data = response.read()
    target = FONT_DIR / filename
    target.write_bytes(data)
    with TTFont(target) as font:
        names = font["name"].names
        copyrights = sorted({n.toUnicode() for n in names if n.nameID == 0})
        descriptions = sorted({n.toUnicode() for n in names if n.nameID == 13})
    if original.startswith("Libertinus"):
        license_text = "\n\n".join(copyrights) + "\n\n" + ofl
        license_id = "OFL-1.1"
    elif original.startswith("NewCM"):
        license_text = "\n\n".join(copyrights) + "\n\n" + gust
        license_id = "LicenseRef-GUST-Font-1.0"
    else:
        if not descriptions or "Bitstream" not in descriptions[0]:
            raise RuntimeError("Missing DejaVu license")
        license_text = "\n\n".join(copyrights + descriptions)
        license_id = "Bitstream-Vera"
    license_file = "licenses/" + filename + ".txt"
    (FONT_DIR / license_file).write_text("\n".join(line.rstrip() for line in license_text.splitlines()).rstrip() + "\n")
    entries.append({"file": filename, "sha256": hashlib.sha256(data).hexdigest(),
                    "source_url": url, "license": license_file, "license_id": license_id})

# This monochrome outline font also works with PDF/A; colour bitmap emoji do
# not provide the same embeddable glyph coverage. Pin source and license together.
emoji_source = "https://raw.githubusercontent.com/google/fonts/29b4ec6df2522a8aee279414b78a07910b065874/ofl/notoemoji/"
emoji_url = emoji_source + "NotoEmoji%5Bwght%5D.ttf"
with urlopen(emoji_url, timeout=30) as response:
    data = response.read()
emoji_path = FONT_DIR / "noto-emoji-vf.ttf"
emoji_path.write_bytes(data)
with TTFont(emoji_path) as font:
    if 0x1F600 not in font.getBestCmap() or font["OS/2"].fsType != 0:
        raise RuntimeError("Emoji font lacks required glyph or unrestricted embedding")
with urlopen(emoji_source + "OFL.txt", timeout=30) as response:
    license_text = response.read().decode("utf-8")
license_file = "licenses/noto-emoji-OFL.txt"
(FONT_DIR / license_file).write_text(license_text)
entries.append({"file": emoji_path.name, "sha256": hashlib.sha256(data).hexdigest(),
                "source_url": emoji_url, "license": license_file, "license_id": "OFL-1.1"})

manifest_file = FONT_DIR / "manifest.json"
manifest = json.loads(manifest_file.read_text())
manifest["typst_preview_fonts"] = entries
manifest_file.write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Materialized {len(entries)} Typst preview fonts with licenses and hashes")
