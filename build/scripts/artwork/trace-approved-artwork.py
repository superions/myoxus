# SPDX-FileCopyrightText: 2026 Myoxus
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Materialize approved raster artwork as real SVG paths and lossless WebP."""

import argparse
import hashlib
import html
import json
from pathlib import Path

import vtracer
from PIL import Image, PngImagePlugin, ImageOps

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "assets/branding/artwork/manifest.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def svg_body(markup):
    return markup[markup.index(">", markup.index("<svg")) + 1 : markup.rindex("</svg>")]


def vectorize(image, transparent, name, expression, source_hash, crisp_color=False):
    width, height = image.size
    config = vtracer.Config(
        mode="spline",
        hierarchical="stacked",
        filter_speckle=1,
        color_precision=8,
        layer_difference=2,
        length_threshold=1.5,
        path_precision=3,
    )
    # Trace color and alpha independently. Tracing RGBA directly thresholds
    # alpha, which creates rough contours and makes soft shadows opaque.
    color = image.convert("RGB").convert("RGBA")
    body = svg_body(config.convert_pixels(color.tobytes(), width, height))
    if transparent:
        alpha = image.getchannel("A").convert("RGB").convert("RGBA")
        config.layer_difference = 1
        alpha_body = svg_body(config.convert_pixels(alpha.tobytes(), width, height))
        # Antialiasing thousands of adjacent color regions exposes dark seams
        # at thumbnail sizes. Keep the independent alpha mask smooth instead.
        color_rendering = ' shape-rendering="crispEdges"' if crisp_color else ""
        body = (
            f'<defs><mask id="artwork-alpha" maskUnits="userSpaceOnUse" '
            f'x="0" y="0" width="{width}" height="{height}" '
            f'style="mask-type:luminance">{alpha_body}</mask></defs>'
            f'<g{color_rendering} mask="url(#artwork-alpha)">{body}</g>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->\n'
        '<!-- SPDX-FileCopyrightText: 2026 Myoxus -->\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" '
        + ('preserveAspectRatio="xMidYMid slice" ' if name.startswith("installer-") else "")
        + f'data-myoxus-artwork="{name}" '
        f'data-myoxus-expression="{expression}" '
        f'data-myoxus-source-sha256="{source_hash}">'
        f'<title>Myoxus {html.escape(name.replace("-", " "))} artwork</title>'
        f'{body}</svg>\n'
    )


def materialize_splash():
    """Downsample the approved welcome original without changing its aspect ratio."""
    source = Image.open(ROOT / "assets/branding/artwork/originals/welcome.png").convert("RGBA")
    target = ROOT / "client/apps/ios/App/App/Assets.xcassets/Splash.imageset"
    info = PngImagePlugin.PngInfo()
    info.add_text("License", "SPDX-License-Identifier: AGPL-3.0-or-later")
    info.add_text("Description", "Myoxus approved welcome artwork")
    for scale, size in [(1, 128), (2, 256), (3, 512)]:
        derivative = ImageOps.pad(source, (size, size), method=Image.Resampling.LANCZOS, color=(0, 0, 0, 0))
        for mode in ["light", "dark"]:
            derivative.save(target / f"myoxus-splash-{mode}@{scale}x.png", pnginfo=info)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="Regenerate one named motif")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    if args.only and not any(item["name"] == args.only for item in manifest["items"]):
        parser.error("unknown motif")
    for item in manifest["items"]:
        if args.only and item["name"] != args.only:
            continue
        source = ROOT / item["original"]
        source_hash = digest(source)
        if source_hash != item["originalSha256"]:
            raise ValueError(f"{item['name']}: approved original has changed")
        image = Image.open(source).convert("RGBA")
        svg = ROOT / item["svg"]
        webp = ROOT / item["webp"]
        svg.parent.mkdir(parents=True, exist_ok=True)
        webp.parent.mkdir(parents=True, exist_ok=True)
        vector_image = image
        if lettering := item.get("lettering"):
            # Trace the empty bubble, then retain the actual shaped Lobster
            # outlines. Re-tracing raster lettering damages small curved glyphs.
            blank = next(entry for entry in manifest["items"] if entry["name"] == item["blankVariant"])
            blank_source = ROOT / blank["original"]
            if digest(blank_source) != blank["originalSha256"]:
                raise ValueError(f"{item['name']}: blank source has changed")
            vector_image = Image.open(blank_source).convert("RGBA")
        markup = vectorize(vector_image, item["transparent"], item["name"], item["expression"], source_hash, item.get("colorRendering") == "crispEdges")
        if lettering:
            outline = svg_body((ROOT / lettering["outline"]).read_text())
            overlay = (
                '<g shape-rendering="geometricPrecision" data-myoxus-lettering="Lobster" '
                f'data-font-sha256="{lettering["fontSha256"]}" '
                f'data-caption="{html.escape(lettering["text"], quote=True)}">{outline}</g>'
            )
            markup = markup.replace("</svg>", overlay + "</svg>")
        svg.write_text(markup)
        image.save(webp, "WEBP", lossless=True, method=6, exact=True)
        item.update(svgSha256=digest(svg), webpSha256=digest(webp))
        MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"{item['name']}: SVG {svg.stat().st_size:,} B; WebP {webp.stat().st_size:,} B", flush=True)

    if not args.only or args.only == "welcome":
        materialize_splash()


if __name__ == "__main__":
    main()
