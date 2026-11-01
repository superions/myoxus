#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "../../..");

const scanRoots = [
  "client",
  "virgultum/editor",
  "virgultum/framework",
  "tests",
  "package.json",
  "yarn.lock",
  ".forgejo/workflows",
];

const ignoredSegments = new Set([
  ".git",
  "dist",
  "lib",
  "node_modules",
  "static",
  "storybook-static",
]);

const legacyBrandIconNamePattern = new RegExp(
  `\\b${["Af", "Fi", "Ne", "Icon"].join("")}\\b`,
);
const legacyAndroidIconNamePattern = new RegExp(
  `\\b${["AF", "Fi", "NE", "Icon"].join("")}(Button)?\\b`,
);
const legacyIosIconsNamePattern = new RegExp(
  `\\b${["Affine", "Icons"].join("")}\\b`,
);
const legacyIconTypeNamePattern = new RegExp(
  `\\bIconType\\.${["Affine", "Icon"].join("")}\\b`,
);
const genericProductLogoIconUsagePattern =
  /(?:import\s*\{[^}]*\bLogo[1-4](?:Duotone)?Icon\b|<Logo[1-4](?:Duotone)?Icon\b|\bLogo[1-4](?:Duotone)?Icon\s*\()/s;
const legacyAbstractBrandFilePattern = /\bMyoxus\.(c8e1713f|57e53ebe)\.svg\b/;
const legacyAbstractBrandPathPattern =
  /M(173\.599 78\.203|159\.714 58\.8634|50\.25 283\.802)/;
const generatedBrandScanRoots = [
  "client/frontends/static",
  "client/apps/electron/resources/web-static",
  "client/apps/electron/out",
  "client/libs/icons/dist",
  "client/web/workspaces/web/dist",
  "client/admin/workspaces/admin/dist",
  "client/apps/electron-renderer/dist",
  "server/runtime/storage",
  "virgultum/editor/shared/dist",
  "virgultum/integration-test/dist",
];

const ignoreQueryPaths = new Map();

function walk(entry, symlinkPath) {
  const abs = path.join(repoRoot, entry);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    ignoreQueryPaths.set(entry, symlinkPath ?? entry);
    return [abs];
  }
  const files = [];
  for (const child of fs.readdirSync(abs)) {
    if (ignoredSegments.has(child)) continue;
    const childAbs = path.join(abs, child);
    let childStat;
    try {
      childStat = fs.statSync(childAbs);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const childRel = path.relative(repoRoot, childAbs);
    const childSymlink =
      symlinkPath ??
      (fs.lstatSync(childAbs).isSymbolicLink() ? childRel : undefined);
    if (childStat.isDirectory()) {
      files.push(...walk(childRel, childSymlink));
    } else {
      ignoreQueryPaths.set(childRel, childSymlink ?? childRel);
      files.push(childAbs);
    }
  }
  return files;
}

function isTextFile(file) {
  return /\.(cjs|css|cts|js|json|jsx|md|mjs|mts|svg|ts|tsx|txt|yml|yaml)$/.test(
    file,
  );
}

function shouldScanGeneratedBrandText(rel, file) {
  if (isTextFile(rel) || path.basename(rel) === "assets-manifest.json") {
    return true;
  }
  // Runtime storage fixture blobs are extensionless, but can still contain SVG
  // branding assets. Keep this bounded so binary app packages are not read.
  return path.extname(rel) === "" && fs.statSync(file).size <= 2 * 1024 * 1024;
}

const failures = [];
const sourceFiles = scanRoots.flatMap((entry) => walk(entry));
const generatedFiles = generatedBrandScanRoots.flatMap((entry) => walk(entry));
const candidates = [...new Set(ignoreQueryPaths.values())];
// Batch the same ignore queries: one Git process per file makes this source
// gate exceed its deadline on a populated development checkout.
// Git rejects paths below symlinks, so query their first symlink ancestor.
const ignoreResult = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
  cwd: repoRoot,
  input: candidates.length ? `${candidates.join("\0")}\0` : "",
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (ignoreResult.error || ![0, 1].includes(ignoreResult.status)) {
  throw new Error(
    `Cannot determine ignored files for the icon boundary check: ${ignoreResult.stderr}`,
    {
      cause: ignoreResult.error ?? ignoreResult.stderr,
    },
  );
}
const ignoredFiles = new Set(ignoreResult.stdout.split("\0").filter(Boolean));

function isGitIgnored(rel) {
  return ignoredFiles.has(ignoreQueryPaths.get(rel) ?? rel);
}

for (const file of sourceFiles) {
  const rel = path.relative(repoRoot, file);
  if (isGitIgnored(rel)) continue;
  if (!isTextFile(rel)) continue;
  if (rel.startsWith("client/libs/icons/")) continue;
  const text = fs.readFileSync(file, "utf8");

  if (/from\s+["']lucide-react["']|lucide-react/.test(text)) {
    failures.push(`${rel}: must not depend on lucide-react icons`);
  }
  if (/@virgultum\/icons\/(rc|lit|keywords)/.test(text)) {
    failures.push(`${rel}: import icons through @myoxus/icons instead`);
  }
  if (/@myoxus\/icons\/rc/.test(text)) {
    failures.push(`${rel}: use @myoxus/icons/react, not the rc alias`);
  }
  if (/cdn\.myoxus\.org\/app-icons/.test(text)) {
    failures.push(`${rel}: app icons must be local generated assets`);
  }
  if (legacyBrandIconNamePattern.test(text)) {
    failures.push(`${rel}: use MyoxusIcon for the product icon export`);
  }
  if (legacyAndroidIconNamePattern.test(text)) {
    failures.push(`${rel}: use MyoxusIcon/MyoxusIconButton`);
  }
  if (legacyIosIconsNamePattern.test(text)) {
    failures.push(`${rel}: use MyoxusIcons`);
  }
  if (legacyIconTypeNamePattern.test(text)) {
    failures.push(`${rel}: use IconType.MyoxusIcon`);
  }
  if (genericProductLogoIconUsagePattern.test(text)) {
    failures.push(
      `${rel}: product logo surfaces must use explicit Myoxus app identity or runtime branding assets, not generic Logo1-Logo4 icon exports`,
    );
  }
  if (/\bBuilding2(Icon)?\b/.test(text)) {
    failures.push(
      `${rel}: use a semantic Myoxus icon name such as OrganizationIcon instead of legacy variant names`,
    );
  }
  if (legacyAbstractBrandFilePattern.test(text)) {
    failures.push(`${rel}: must not reference removed abstract brand asset`);
  }
  if (legacyAbstractBrandPathPattern.test(text)) {
    failures.push(`${rel}: must not embed removed abstract brand geometry`);
  }
}

for (const file of generatedFiles) {
  const rel = path.relative(repoRoot, file);
  // Build outputs and runtime storage are intentionally gitignored. Scanning
  // tracked generated assets is a source gate; scanning stale local bundles
  // would make the package check depend on unrelated runtime state.
  if (isGitIgnored(rel)) continue;
  if (legacyAbstractBrandFilePattern.test(rel)) {
    failures.push(`${rel}: removed abstract legacy brand asset must not exist`);
  }
  if (!shouldScanGeneratedBrandText(rel, file)) continue;
  const text = fs.readFileSync(file, "utf8");
  if (legacyAbstractBrandFilePattern.test(text)) {
    failures.push(`${rel}: must not reference removed abstract brand asset`);
  }
  if (legacyAbstractBrandPathPattern.test(text)) {
    failures.push(`${rel}: must not embed removed abstract brand geometry`);
  }
  if (
    legacyBrandIconNamePattern.test(text) ||
    legacyIconTypeNamePattern.test(text)
  ) {
    failures.push(
      `${rel}: generated output contains removed product icon name`,
    );
  }
}

if (failures.length) {
  console.error("Myoxus icon boundary check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Myoxus icon boundary check passed.");
