// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import fs from "node:fs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const colors = { black: "#000000", white: "#ffffff" };

// Only the authoring build rasterizes geometry. Check mode validates the stored
// source/asset hashes; normal builds reuse unchanged pairs without a browser.
export async function documentIconAssets(icons, output, check) {
  const previous = fs.existsSync(output)
    ? JSON.parse(fs.readFileSync(output, "utf8")).icons
    : {};
  const catalog = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../../server/static/branding/theme-catalog.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const palette = Object.entries(catalog.contentColors.light).filter(([key]) =>
    key.includes("foreground-"),
  );
  const tones = { ...colors, ...Object.fromEntries(palette) };
  const result = {};
  const pending = [];
  for (const [name, svg] of icons) {
    const source = hash(`document-icons-v2\n${svg}`);
    const cached = previous[name];
    result[name] =
      cached?.source === source
        ? { ...cached, colorPngs: { ...cached.colorPngs } }
        : { source, colorPngs: {} };
    for (const [tone, color] of Object.entries(tones)) {
      const neutral = tone === "black" || tone === "white";
      const asset = neutral ? cached?.[tone] : cached?.colorPngs?.[tone];
      const vector = neutral ? asset?.svg : cached?.colors?.[tone];
      if (
        cached?.source === source &&
        vector === svg.replaceAll("currentColor", color) &&
        typeof asset?.png === "string" &&
        asset.png.startsWith("iVBORw0KGgo") &&
        asset.sha256 === hash(Buffer.from(asset.png, "base64")) &&
        Array.isArray(cached.black?.inkBounds)
      )
        continue;
      if (check)
        throw new Error(
          `Document icon assets are stale (${name}/${tone}); run yarn workspace @virgultum/icons build.`,
        );
      pending.push({ name, tone, svg: svg.replaceAll("currentColor", color) });
    }
  }

  if (pending.length) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const rendered = await page.evaluate(async (assets) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 96;
        const ctx = canvas.getContext("2d");
        for (const asset of assets) {
          const url = URL.createObjectURL(
            new Blob([asset.svg], { type: "image/svg+xml" }),
          );
          try {
            const image = new Image();
            image.src = url;
            await image.decode();
            ctx.clearRect(0, 0, 96, 96);
            ctx.drawImage(image, 0, 0, 96, 96);
            const pixels = ctx.getImageData(0, 0, 96, 96).data;
            let left = 96,
              top = 96,
              right = 0,
              bottom = 0;
            for (let y = 0; y < 96; y++)
              for (let x = 0; x < 96; x++) {
                if (pixels[(y * 96 + x) * 4 + 3] >= 128) {
                  left = Math.min(left, x);
                  top = Math.min(top, y);
                  right = Math.max(right, x + 1);
                  bottom = Math.max(bottom, y + 1);
                }
              }
            if (right <= left || bottom <= top) {
              throw new Error(`Empty document icon: ${asset.name}`);
            }
            asset.inkBounds = [left, top, right, bottom];
            asset.png = canvas.toDataURL("image/png").split(",")[1];
          } finally {
            URL.revokeObjectURL(url);
          }
        }
        return assets;
      }, pending);
      for (const { name, tone, svg, png, inkBounds } of rendered) {
        if (tone === "black" || tone === "white")
          result[name][tone] = {
            svg,
            png,
            inkBounds,
            sha256: hash(Buffer.from(png, "base64")),
          };
        else
          result[name].colorPngs[tone] = {
            png,
            sha256: hash(Buffer.from(png, "base64")),
          };
      }
    } finally {
      await browser.close();
    }
  }
  for (const [name, svg] of icons) {
    result[name].colors = Object.fromEntries(
      palette.map(([reference, color]) => [
        reference,
        svg.replaceAll("currentColor", color),
      ]),
    );
  }
  return result;
}
