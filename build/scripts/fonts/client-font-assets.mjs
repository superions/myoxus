#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const sourceFontsDir = path.join(repoRoot, "server", "static", "fonts");
const cssSource = path.join(
  repoRoot,
  "client",
  "branding",
  "theme-fallback.css",
);

function usage() {
  console.error(`Usage:
  node build/scripts/fonts/client-font-assets.mjs copy --target-root <dir>
  node build/scripts/fonts/client-font-assets.mjs verify --target-root <dir>
  node build/scripts/fonts/client-font-assets.mjs verify-asar --asar <file> [--asar-root resources/web-static]
`);
}

function readArg(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function requiredFontFiles() {
  const files = new Set();
  const urlPattern =
    /url\(\s*['"]?\/api\/fonts\/([^'")?#]+)(?:\?[^'")]*)?['"]?\s*\)/g;

  const css = await readFile(cssSource, "utf8");
  for (const match of css.matchAll(urlPattern)) {
    files.add(decodeURIComponent(match[1]));
  }

  return [...files].sort();
}

async function assertRequiredSourceFontsExist() {
  const missing = [];
  for (const file of await requiredFontFiles()) {
    if (!existsSync(path.join(sourceFontsDir, file))) {
      missing.push(file);
    }
  }
  if (missing.length) {
    throw new Error(
      `server/static/fonts is missing required theme font files:\n${missing.join(
        "\n",
      )}`,
    );
  }
}

async function copyFonts(targetRoot) {
  await assertRequiredSourceFontsExist();

  const targetFontsDir = path.join(targetRoot, "api", "fonts");
  await rm(targetFontsDir, { recursive: true, force: true });
  await mkdir(path.dirname(targetFontsDir), { recursive: true });
  await cp(sourceFontsDir, targetFontsDir, { recursive: true });
  await verifyFontTree(targetRoot);
  console.log(`[PASS] copied client font assets to ${targetFontsDir}`);
}

async function verifyFontTree(targetRoot) {
  const targetFontsDir = path.join(targetRoot, "api", "fonts");
  const missing = [];

  for (const file of await requiredFontFiles()) {
    const candidate = path.join(targetFontsDir, file);
    try {
      const fileStat = await stat(candidate);
      if (!fileStat.isFile() || fileStat.size === 0) {
        missing.push(file);
      }
    } catch {
      missing.push(file);
    }
  }

  if (missing.length) {
    throw new Error(
      `client font asset tree ${targetFontsDir} is missing required files:\n${missing.join(
        "\n",
      )}`,
    );
  }

  console.log(`[PASS] verified client font assets in ${targetFontsDir}`);
}

async function verifyAsar(asarPath, asarRoot) {
  const { listPackage } = await import("@electron/asar");
  const normalizedRoot = asarRoot.replace(/^\/+|\/+$/g, "");
  const entries = new Set(listPackage(asarPath));
  const missing = [];

  for (const file of await requiredFontFiles()) {
    const asarEntry = `/${normalizedRoot}/api/fonts/${file}`;
    if (!entries.has(asarEntry)) {
      missing.push(asarEntry);
    }
  }

  if (missing.length) {
    throw new Error(
      `packaged asar is missing required client font assets:\n${missing.join(
        "\n",
      )}`,
    );
  }

  console.log(`[PASS] verified client font assets in ${asarPath}`);
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "copy") {
    const targetRoot = readArg(args, "--target-root");
    if (!targetRoot) {
      throw new Error("copy requires --target-root");
    }
    await copyFonts(path.resolve(targetRoot));
  } else if (command === "verify") {
    const targetRoot = readArg(args, "--target-root");
    if (!targetRoot) {
      throw new Error("verify requires --target-root");
    }
    await verifyFontTree(path.resolve(targetRoot));
  } else if (command === "verify-asar") {
    const asarPath = readArg(args, "--asar");
    if (!asarPath) {
      throw new Error("verify-asar requires --asar");
    }
    await verifyAsar(
      path.resolve(asarPath),
      readArg(args, "--asar-root") ?? "resources/web-static",
    );
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
