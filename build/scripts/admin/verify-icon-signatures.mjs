#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

const signatures = [
  {
    name: "DatabaseIcon",
    purpose: "storage nav must render as a stacked database cylinder",
    markers: ["M4 6a8 3 0 1 0 16 0", "M4 6v6a8 3", "M4 12v6a8 3"],
  },
  {
    name: "OrganizationIcon",
    purpose: "organization nav must render as an office building",
    markers: ["M5 21v-16a2 2", "M3 21l18 0", "M9 8l1 0"],
  },
  {
    name: "DocsIcon",
    purpose: "documents nav must render as stacked documents",
    markers: ["M18 17h-7a2 2 0 0 1 -2 -2", "M16 17v2a2 2 0 0 1 -2 2"],
  },
  {
    name: "ExportToPdfIcon",
    purpose: "PDF export nav must render as a document with an outbound arrow",
    markers: ["M5 12v-7a2 2", "M20 15h-3v6"],
  },
  {
    name: "ScrollTextIcon",
    purpose: "audit log nav must render as scroll/text",
    markers: ["M17 21h-10a2 2", "M9 13l6 0", "M9 17l6 0"],
  },
  {
    name: "CloudWorkspaceIcon",
    purpose: "workspace nav must render as the canonical cloud workspace motif",
    markers: ["M6.657 18c-2.572", "h.99c1.913"],
  },
  {
    name: "BookTemplateIcon",
    purpose: "template nav must render as book/template",
    markers: ["M4 5a1 1", "M14 12l6 0"],
  },
  {
    name: "PaletteIcon",
    purpose: "design nav must render as a painter palette",
    markers: ["M12 21a9 9", "M7.5 10.5a1 1", "M15.5 10.5a1 1"],
  },
  {
    // The shared UploadTarget renders UploadIcon; unused catalog icons are tree-shaken.
    name: "UploadIcon",
    purpose: "template import must render with a clear upload arrow",
    markers: ["M4 17v2a2 2", "M7 9l5 -5l5 5", "M12 4l0 12"],
  },
  {
    name: "ExternalLinkIcon",
    purpose: "external link actions must render with a clear outbound arrow",
    markers: ["M12 6h-6a2 2", "M11 13l9 -9", "M15 4h5v5"],
  },
];

function usage() {
  console.error(
    [
      "Usage:",
      "  verify-icon-signatures.mjs --static-dir <client/frontends/static/admin>",
      "  verify-icon-signatures.mjs --url <frontend-base-url>",
      "",
      "The gate checks semantic Myoxus admin icon geometry in built artifacts.",
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

function walkJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
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

function verifyText(text, sourceLabel) {
  const failures = [];
  for (const signature of signatures) {
    const missing = signature.markers.filter(
      (marker) => !text.includes(marker),
    );
    if (missing.length) {
      failures.push({ ...signature, missing });
    }
  }

  if (failures.length) {
    console.error("Admin icon semantic signature verification failed.");
    console.error(`Source: ${sourceLabel}`);
    for (const failure of failures) {
      console.error(`- ${failure.name}: ${failure.purpose}`);
      for (const marker of failure.missing) {
        console.error(`  missing marker: ${marker}`);
      }
    }
    process.exit(1);
  }

  console.log("[PASS] admin icon semantic signatures");
  console.log(`       source: ${sourceLabel}`);
  console.log(`       checked icons: ${signatures.length}`);
}

async function verifyStatic(staticDir) {
  const jsDir = adminJsDir(staticDir);
  const files = walkJsFiles(jsDir);
  if (!files.length) throw new Error(`No JS files found in ${jsDir}`);
  const text = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  verifyText(text, `${jsDir} (${files.length} JS files)`);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "myoxus-icon-signature-gate/1.0" },
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

async function verifyUrl(input) {
  const shellUrl = adminShellUrl(input);
  const html = await fetchText(shellUrl);
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], shellUrl).href)
    .filter((src) => {
      const pathname = new URL(src).pathname;
      return (
        (pathname.includes("/adminfrontend/") ||
          pathname.includes("/admin/")) &&
        pathname.endsWith(".js")
      );
    });

  if (!scripts.length) {
    throw new Error(`No admin JS script tags found in ${shellUrl.href}`);
  }

  const chunks = [];
  for (const script of scripts) {
    chunks.push(await fetchText(script));
  }
  verifyText(
    chunks.join("\n"),
    `${shellUrl.href} (${scripts.length} JS files)`,
  );
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  usage();
  process.exit(2);
}

try {
  if (parsed.mode === "static") {
    await verifyStatic(parsed.value);
  } else {
    await verifyUrl(parsed.value);
  }
} catch (error) {
  console.error(
    `[FAIL] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
