#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");

const forbiddenFiles = [
  "build/scripts/virgultum/revendor-icons.sh",
  "virgultum/icons/scripts/update.sh",
];

const scanRoots = [
  "virgultum/icons",
  "build/scripts",
  "package.json",
  "yarn.lock",
  ".forgejo/workflows",
];

const forbiddenPatterns = [
  {
    pattern: /@blocksuite\/icons/g,
    message:
      "must not reference or download the legacy BlockSuite icon package",
  },
  {
    pattern: /revendor-icons/g,
    message: "must not keep the old icon re-vendor workflow",
  },
  {
    pattern: /npm\s+pack\s+["']?@blocksuite\/icons/g,
    message: "must not fetch icon tarballs from npm",
  },
  {
    pattern: /vendored snapshot/gi,
    message: "must not describe the active icon package as a vendored snapshot",
  },
  {
    pattern: new RegExp(`\\b${["Af", "Fi", "Ne", "Icon"].join("")}\\b`, "g"),
    message: "must not expose the removed legacy product icon export name",
  },
  {
    pattern: /M(173\.599 78\.203|159\.714 58\.8634|50\.25 283\.802)/g,
    message: "must not reintroduce removed abstract legacy brand geometry",
  },
];

const provenanceOnlyFiles = new Set([
  "virgultum/icons/PROVENANCE.md",
  "virgultum/icons/scripts/check-no-legacy-icons.mjs",
]);

function walk(entry) {
  const abs = path.join(repoRoot, entry);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  const result = [];
  for (const child of fs.readdirSync(abs)) {
    const childAbs = path.join(abs, child);
    const childStat = fs.statSync(childAbs);
    if (childStat.isDirectory()) {
      if (child === "node_modules" || child === ".git") continue;
      result.push(...walk(path.relative(repoRoot, childAbs)));
    } else {
      result.push(childAbs);
    }
  }
  return result;
}

const failures = [];

for (const file of forbiddenFiles) {
  if (fs.existsSync(path.join(repoRoot, file))) {
    failures.push(`${file}: old legacy icon fetch script still exists`);
  }
}

for (const file of scanRoots.flatMap(walk)) {
  const rel = path.relative(repoRoot, file);
  if (provenanceOnlyFiles.has(rel)) continue;
  if (
    rel.endsWith(".png") ||
    rel.endsWith(".jpg") ||
    rel.endsWith(".ico") ||
    rel.endsWith(".icns")
  )
    continue;
  const text = fs.readFileSync(file, "utf8");
  for (const { pattern, message } of forbiddenPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      failures.push(`${rel}: ${message}`);
    }
  }
}

const pkg = JSON.parse(
  fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
);
if (pkg.license !== "AGPL-3.0-or-later AND MIT") {
  failures.push(
    "virgultum/icons/package.json: preserve AGPL code and reviewed MIT glyph licensing",
  );
}

if (failures.length) {
  console.error("Legacy icon gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Legacy icon gate passed.");
