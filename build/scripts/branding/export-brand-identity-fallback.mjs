#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outPath = resolve(
  repoRoot,
  "client/branding/brand-identity-fallback.json",
);
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

const faviconNames = [
  "favicon-32.png",
  "favicon-36.png",
  "favicon-48.png",
  "favicon-72.png",
  "favicon-96.png",
  "favicon-144.png",
  "favicon-192.png",
  "favicon.ico",
  "apple-touch-icon.png",
];

const assetInputs = {
  logo: {
    source: "assets/branding/myoxus_text.svg",
    publicUrl: "/style/logo.svg",
    slot: "logo",
    variant: "large",
    qualityClass: "web",
    storageKind: "style_static",
    storageKey: "logo.svg",
    mime: "image/svg+xml",
  },
  productMark: {
    source: "client/libs/icons/src/assets/platform/browser-favicon.svg",
    publicUrl: "/style/product-mark.svg",
    slot: "product_mark",
    variant: "mark",
    qualityClass: "web",
    storageKind: "style_static",
    storageKey: "product-mark.svg",
    mime: "image/svg+xml",
  },
};

if (args.has("--help")) {
  console.log(`Usage: export-brand-identity-fallback.mjs [--check]

Generates the client-side app/server brand identity fallback consumed by Web,
Admin and Electron startup/offline paths. The fallback is generated only from
bundled local assets and is not an authoring source.

  yarn branding:brand-identity-fallback
  yarn branding:brand-identity-fallback:check`);
  process.exit(0);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readAsset(relPath) {
  const absPath = resolve(repoRoot, relPath);
  const body = readFileSync(absPath);
  return {
    absPath,
    relPath,
    sha256: sha256(body),
    byteSize: statSync(absPath).size,
  };
}

function cacheBustedUrl(publicUrl, hash) {
  return `${publicUrl}?v=${hash.slice(0, 16)}`;
}

function generatedAsset(input) {
  const asset = readAsset(input.source);
  return {
    slot: input.slot,
    variant: input.variant,
    qualityClass: input.qualityClass,
    storageKind: input.storageKind,
    storageKey: input.storageKey,
    publicUrl: cacheBustedUrl(input.publicUrl, asset.sha256),
    mime: input.mime,
    sha256: asset.sha256,
    byteSize: asset.byteSize,
  };
}

function assertElectronCopyContract() {
  const rspackConfig = readFileSync(
    resolve(repoRoot, "tools/cli/src/rspack/index.ts"),
    "utf8",
  );
  if (
    !rspackConfig.includes("buildConfig.isElectron") ||
    !rspackConfig.includes('ProjectRoot.join("client/branding")') ||
    !rspackConfig.includes("assets/branding/myoxus_text.svg") ||
    !rspackConfig.includes(
      "client/libs/icons/src/assets/platform/browser-favicon.svg",
    ) ||
    !rspackConfig.includes('to: "style/logo.svg"') ||
    !rspackConfig.includes('to: "style/product-mark.svg"')
  ) {
    throw new Error(
      "electron copy contract missing: Rspack must copy client/branding plus canonical brand assets to style/",
    );
  }
}

function aggregateFavicons() {
  const entries = faviconNames.map((name) => {
    const relPath = `client/libs/core/public/${name}`;
    const asset = readAsset(relPath);
    const size = name.match(/^favicon-(\d+)\.png$/u)?.[1];
    return {
      storageKey: name,
      publicUrl: cacheBustedUrl(`/${name}`, asset.sha256),
      mime: name.endsWith(".ico") ? "image/x-icon" : "image/png",
      sha256: asset.sha256,
      byteSize: asset.byteSize,
      ...(size ? { sizePx: Number(size) } : {}),
    };
  });
  const aggregateHash = sha256(Buffer.from(stableStringify(entries)));
  return {
    asset: {
      slot: "favicon_pack",
      variant: "pack",
      qualityClass: "favicon",
      storageKind: "static_root",
      storageKey: "favicon-pack",
      publicUrl: cacheBustedUrl("/favicon-192.png", aggregateHash),
      mime: "application/vnd.myoxus.favicon-pack+json",
      sha256: aggregateHash,
      byteSize: entries.reduce((sum, entry) => sum + entry.byteSize, 0),
    },
    entries,
  };
}

function buildFallback() {
  assertElectronCopyContract();
  const faviconPack = aggregateFavicons();
  const generatedFrom = [
    assetInputs.logo.source,
    assetInputs.productMark.source,
    ...faviconNames.map((name) => `client/libs/core/public/${name}`),
  ];
  const appServerBranding = {
    logo: generatedAsset(assetInputs.logo),
    productMark: generatedAsset(assetInputs.productMark),
    faviconPack: faviconPack.asset,
  };
  const contentHash = sha256(Buffer.from(stableStringify(appServerBranding)));
  return {
    schemaVersion: 1,
    contentHash,
    generatedFrom,
    appServerBranding,
    favicons: faviconPack.entries,
  };
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const next = formatJson(buildFallback());

if (checkOnly) {
  const current = readFileSync(outPath, "utf8");
  if (current !== next) {
    console.error(
      `[FAIL] ${relative(repoRoot, outPath)} is stale. Run yarn branding:brand-identity-fallback.`,
    );
    process.exit(1);
  }
  console.log(`[PASS] ${relative(repoRoot, outPath)} is up to date`);
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, next);
console.log(`[OK] wrote ${relative(repoRoot, outPath)}`);
