#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Materialize the preview's existing Typst baseline on the owned font endpoint."""

import hashlib
import json
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
with urlopen("https://tug.org/fonts/licenses/GUST-FONT-LICENSE.txt", timeout=30) as response:
    gust = response.read().decode("utf-8")
if "version 1.0" not in gust:
    raise RuntimeError("Unexpected GUST license document")

entries = []
for original in FILES:
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

manifest_file = FONT_DIR / "manifest.json"
manifest = json.loads(manifest_file.read_text())
manifest["typst_preview_fonts"] = entries
manifest_file.write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Materialized {len(entries)} Typst preview fonts with licenses and hashes")
