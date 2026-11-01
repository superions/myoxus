#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function usage() {
  console.error(
    [
      "Usage:",
      "  verify-documents-audit-bundle.mjs --static-dir <client/frontends/static/admin>",
      "  verify-documents-audit-bundle.mjs --url <frontend-base-url>",
      "",
      "The gate checks the built Admin Documents chunk, not source files.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 1 && /^https?:\/\//.test(args[0])) {
    return { mode: "url", value: args[0] };
  }
  if (args.length === 1) {
    return { mode: "static", value: args[0] };
  }

  const flag = args.shift();
  const value = args.shift();
  if (!flag || !value || args.length) return null;
  if (flag === "--static-dir") return { mode: "static", value };
  if (flag === "--url") return { mode: "url", value };
  return null;
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(abs));
    } else if (entry.isFile()) {
      files.push(abs);
    }
  }
  return files;
}

function adminJsDir(staticDir) {
  const absStaticDir = path.resolve(repoRoot, staticDir);
  const candidates = [
    path.join(absStaticDir, "adminfrontend", "js"),
    path.join(absStaticDir, "js"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `No admin JS directory found under ${absStaticDir}. Expected adminfrontend/js or js.`,
    );
  }
  return found;
}

function assertDocumentsAuditBundle(text, sourceLabel) {
  const failures = [];
  const checks = [
    {
      ok: text.includes("adminDocumentAuditLog"),
      message: "missing adminDocumentAuditLog operation",
    },
    {
      ok: !/\badminAuditLog\b/.test(text),
      message: "contains old global adminAuditLog operation",
    },
    {
      ok: !/document_attribute(?!s)/.test(text),
      message: "contains old singular document_attribute category",
    },
    {
      ok: !/audit-category/.test(text),
      message: "contains old category-select UI marker",
    },
    {
      ok: !/admin\.documents\.audit\.category\.all/.test(text),
      message: "contains old global-audit category i18n marker",
    },
  ];

  for (const check of checks) {
    if (!check.ok) failures.push(check.message);
  }

  if (failures.length) {
    console.error("Admin Documents audit bundle verification failed.");
    console.error(`Source: ${sourceLabel}`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("[PASS] admin documents audit bundle");
  console.log(`       source: ${sourceLabel}`);
}

function verifyStatic(staticDir) {
  const jsDir = adminJsDir(staticDir);
  const chunkFiles = walkFiles(jsDir).filter((file) => {
    const name = path.basename(file);
    return (
      name.endsWith(".js") &&
      (/^documents\.[^.]+\.js$/.test(name) || /^\d+\.[^.]+\.js$/.test(name))
    );
  });
  const files = chunkFiles.filter((file) =>
    fs.readFileSync(file, "utf8").includes("adminDocumentAuditLog"),
  );

  if (!files.length) {
    throw new Error(`No Admin Documents route chunk found in ${jsDir}`);
  }
  if (files.length > 1) {
    throw new Error(
      `Expected exactly one documents chunk in ${jsDir}, found ${files.length}: ${files.join(", ")}`,
    );
  }

  assertDocumentsAuditBundle(
    fs.readFileSync(files[0], "utf8"),
    path.relative(repoRoot, files[0]),
  );
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "myoxus-documents-audit-bundle-gate/1.0" },
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  return response.text();
}

function adminShellUrl(input) {
  const url = new URL(input);
  if (url.pathname.includes("/adminfrontend")) {
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL("adminfrontend/", url);
}

function scriptUrls(html, shellUrl) {
  return [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], shellUrl))
    .filter(
      (url) => url.pathname.includes("/admin/") && url.pathname.endsWith(".js"),
    );
}

function namedDocumentsChunkUrl(scriptTexts, scriptBases) {
  for (let i = 0; i < scriptTexts.length; i += 1) {
    const text = scriptTexts[i];
    const nameMatch = text.match(/([0-9]+):"documents"/);
    if (!nameMatch) continue;

    const chunkId = nameMatch[1];
    const hashMatch = text.match(new RegExp(`${chunkId}:"([a-f0-9]{8,})"`));
    if (!hashMatch) {
      throw new Error(
        `Runtime maps chunk ${chunkId} to documents but no hash entry was found`,
      );
    }

    return new URL(`documents.${hashMatch[1]}.js`, scriptBases[i]);
  }

  return null;
}

function numericChunkUrls(scriptTexts, scriptBases) {
  const urls = new Map();
  for (let i = 0; i < scriptTexts.length; i += 1) {
    for (const match of scriptTexts[i].matchAll(
      /(?:^|[,;{])(\d+):"([a-f0-9]{8,})"/g,
    )) {
      const url = new URL(`${match[1]}.${match[2]}.js`, scriptBases[i]);
      urls.set(url.href, url);
    }
  }

  return [...urls.values()];
}

async function findDocumentsChunkUrl(scriptTexts, scriptBases) {
  const namedChunk = namedDocumentsChunkUrl(scriptTexts, scriptBases);
  if (namedChunk) return namedChunk;

  // Current Rspack production builds use numeric async chunk names. Resolve
  // the emitted runtime map and inspect those artifacts instead of assuming a
  // source module name survives optimization.
  const candidates = numericChunkUrls(scriptTexts, scriptBases);
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = candidates.slice(index, index + 8);
    const texts = await Promise.all(
      batch.map(async (url) => {
        const response = await fetch(url, {
          headers: { "user-agent": "myoxus-documents-audit-bundle-gate/1.0" },
        });
        return response.ok ? response.text() : "";
      }),
    );
    const matches = batch.filter((_, candidateIndex) =>
      texts[candidateIndex].includes("adminDocumentAuditLog"),
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Admin Documents route chunks were found: ${matches.join(", ")}`,
      );
    }
    if (matches.length === 1) return matches[0];
  }

  throw new Error(
    "No runtime chunk manifest entry for the Admin Documents route was found",
  );
}

async function verifyUrl(input) {
  const shellUrl = adminShellUrl(input);
  const html = await fetchText(shellUrl);
  const scripts = scriptUrls(html, shellUrl);

  if (!scripts.length) {
    throw new Error(`No admin JS script tags found in ${shellUrl.href}`);
  }

  const scriptTexts = [];
  const scriptBases = [];
  for (const script of scripts) {
    scriptTexts.push(await fetchText(script));
    scriptBases.push(new URL(".", script));
  }

  const documentsChunkUrl = await findDocumentsChunkUrl(
    scriptTexts,
    scriptBases,
  );
  const documentsChunk = await fetchText(documentsChunkUrl);
  assertDocumentsAuditBundle(documentsChunk, documentsChunkUrl.href);
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  usage();
  process.exit(2);
}

try {
  if (parsed.mode === "static") {
    verifyStatic(parsed.value);
  } else {
    await verifyUrl(parsed.value);
  }
} catch (error) {
  console.error(
    `[FAIL] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
