#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const catalogPath = resolve(
  repoRoot,
  "server/static/branding/theme-catalog.json",
);
const fontsRoot = resolve(repoRoot, "server/static/fonts");

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const requiredPdfRoles = new Set(["heading", "body", "mono", "symbol"]);
const findings = [];

function addFinding(message) {
  findings.push(message);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureLocalFontAsset(asset, family) {
  if (!asset.assetKey || /^(?:https?:)?\/\//i.test(asset.assetKey)) {
    addFinding(`${family.slug}: asset ${asset.assetKey} must be a local key`);
    return;
  }
  const absolutePath = resolve(fontsRoot, asset.assetKey);
  if (!absolutePath.startsWith(`${fontsRoot}/`)) {
    addFinding(`${family.slug}: asset escapes font root: ${asset.assetKey}`);
    return;
  }
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      addFinding(`${family.slug}: asset is not a file: ${asset.assetKey}`);
      return;
    }
  } catch {
    addFinding(`${family.slug}: asset file missing: ${asset.assetKey}`);
    return;
  }
  if (!asset.sha256) {
    addFinding(`${family.slug}: asset ${asset.assetKey} has no sha256`);
    return;
  }
  const actual = sha256(absolutePath);
  if (actual !== asset.sha256) {
    addFinding(
      `${family.slug}: asset ${asset.assetKey} sha256 drift: catalog=${asset.sha256} actual=${actual}`,
    );
  }
}

const familiesByCss = new Map();
for (const family of catalog.fontFamilies ?? []) {
  familiesByCss.set(family.cssFamily, family);
  familiesByCss.set(family.displayName, family);

  const assets = family.assets ?? [];
  for (const asset of assets) {
    ensureLocalFontAsset(asset, family);
  }

  const webAssets = assets.filter((asset) => asset.usage === "web");
  const pdfAssets = assets.filter((asset) => asset.usage === "pdf");
  if (family.isSelectable) {
    if (family.licenseStatus !== "approved") {
      addFinding(`${family.slug}: selectable family is not license-approved`);
    }
    if (!webAssets.some((asset) => asset.format === "woff2")) {
      addFinding(`${family.slug}: selectable family has no WOFF2 web asset`);
    }
    if (
      !pdfAssets.some((asset) =>
        ["ttf", "otf", "variable_ttf"].includes(asset.format),
      )
    ) {
      addFinding(`${family.slug}: selectable family has no PDF-capable asset`);
    }
  }
}

for (const theme of catalog.themes ?? []) {
  const seenPdfRoles = new Set();
  for (const style of theme.typographyStyles ?? []) {
    const family = familiesByCss.get(style.fontFamily);
    if (!family) {
      addFinding(
        `${theme.slug}.${style.styleKey}: font family ${style.fontFamily} is not in fontFamilies`,
      );
      continue;
    }
    if (style.pdfRole) {
      seenPdfRoles.add(style.pdfRole);
      const hasPdfAsset = (family.assets ?? []).some(
        (asset) => asset.usage === "pdf" && asset.sha256,
      );
      if (!hasPdfAsset) {
        addFinding(
          `${theme.slug}.${style.styleKey}: pdfRole ${style.pdfRole} uses family ${family.slug} without PDF asset`,
        );
      }
    }
  }
  for (const role of requiredPdfRoles) {
    if (!seenPdfRoles.has(role)) {
      addFinding(`${theme.slug}: missing required PDF font role ${role}`);
    }
  }
}

if (findings.length > 0) {
  console.error("theme font materialization guard failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log(
  `theme font materialization ok: families=${catalog.fontFamilies?.length ?? 0} themes=${catalog.themes?.length ?? 0}`,
);
