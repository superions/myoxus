#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Explicit client provenance audit.
 *
 * This verifier is intentionally not wired into normal build, typecheck,
 * changed-path test selection, or container release. It is run only when a
 * provenance audit or source-release review is explicitly requested.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = "client/provenance/components.json";
const REUSE_TOML_PATH = "client/REUSE.toml";
const UPSTREAM_LICENSE_PATH = "client/provenance/LICENSE-UPSTREAM-MIT.txt";
const SUPPORTED_SCHEMA = 1;
const MYOXUS_NOTICE = "2026-present Daniel Scharf and Myoxus contributors";
const UPSTREAM_ATTRIBUTION =
  "2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.";
const UPSTREAM_ORIGINAL_NOTICE =
  "2022-present TOEVERYTHING PTE. LTD. and its affiliates.";
const GOOGLE_NOTICE = "2018 Google LLC";
const CUTOFF_REVISION = "e31cca33540af2737dc9e520b70acac170c0709e";
const CUTOFF_DATE = "2026-03-04";
const UPSTREAM_LICENSE_SHA256 =
  "c107c8088fe42bce6def95d313cfe7b5984d3bb2c1608b67f855327da45f497b";
const SKIPPED_DIRECTORIES = new Set([".git", ".yarn", "node_modules"]);
const LICENSE_FILE_NAMES = new Set([
  "COPYING",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
]);
const RESTRICTED_PATHS = ["packages/backend", "packages/common/native"];
const KNOWN_ORIGINS = new Set(["M0", "C0", "F1", "F2", "T1", "U0"]);
const GLOB_REGEXES = new Map();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function globToRegex(pattern) {
  const cached = GLOB_REGEXES.get(pattern);
  if (cached) return cached;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  const compiled = new RegExp(`^${escaped}/?$`);
  GLOB_REGEXES.set(pattern, compiled);
  return compiled;
}

export function pathMatches(path, pattern) {
  return globToRegex(pattern).test(path);
}

function walk(root, relativeRoot) {
  const results = [];
  const absoluteRoot = join(root, relativeRoot);
  if (!existsSync(absoluteRoot)) return results;
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        results.push(relative(root, absolute).replaceAll("\\", "/"));
      } else if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        results.push(relative(root, absolute).replaceAll("\\", "/"));
      }
    }
  }
  return results;
}

export function collectScopedFiles(repoRoot, roots) {
  if (existsSync(join(repoRoot, ".git"))) {
    try {
      return execFileSync("git", ["ls-files", "-z", "--", ...roots], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      })
        .split("\0")
        .filter(Boolean)
        .sort();
    } catch {
      // A source archive or fixture may not have Git metadata.
    }
  }
  // An extracted source tree has no Git ignore context. Directory names such
  // as scripts/lib are real source; unexpected build output must cause drift.
  return [...new Set(roots.flatMap((root) => walk(repoRoot, root)))].sort();
}

function parseTomlArray(inner) {
  const values = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of inner) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      current += character;
      quoted = !quoted;
      continue;
    }
    if (character === "," && !quoted) {
      if (current.trim()) values.push(JSON.parse(current.trim()));
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) values.push(JSON.parse(current.trim()));
  return values;
}

export function loadReuseAnnotations(repoRoot) {
  const absolute = join(repoRoot, REUSE_TOML_PATH);
  if (!existsSync(absolute)) {
    throw new Error(`${REUSE_TOML_PATH} is missing`);
  }
  const annotations = [];
  let annotation = null;
  let arrayKey = null;
  for (const raw of readFileSync(absolute, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[annotations]]") {
      if (annotation) annotations.push(annotation);
      annotation = {};
      arrayKey = null;
      continue;
    }
    if (!annotation) continue;
    if (arrayKey) {
      if (line === "]") {
        arrayKey = null;
      } else {
        annotation[arrayKey].push(JSON.parse(line.replace(/,\s*$/, "")));
      }
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue === "[") {
      annotation[key] = [];
      arrayKey = key;
    } else if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      annotation[key] = parseTomlArray(rawValue.slice(1, -1));
    } else if (rawValue.startsWith('"')) {
      annotation[key] = JSON.parse(rawValue);
    } else if (rawValue === "true" || rawValue === "false") {
      annotation[key] = rawValue === "true";
    } else {
      annotation[key] = rawValue;
    }
  }
  if (annotation) annotations.push(annotation);
  return annotations;
}

function annotationPaths(annotation) {
  const value = annotation.path;
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

function matchingAnnotations(annotations, repoRelativePath) {
  const clientRelative = repoRelativePath.startsWith("client/")
    ? repoRelativePath.slice("client/".length)
    : repoRelativePath;
  return annotations.filter((annotation) =>
    annotationPaths(annotation).some((pattern) =>
      pathMatches(clientRelative, pattern),
    ),
  );
}

function normalizeStrings(value) {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string")
    : [];
}

export function parseFileSpdx(repoRoot, file) {
  const buffer = readFileSync(join(repoRoot, file));
  if (buffer.includes(0)) return { copyright: [], licenses: [] };
  const text = buffer.toString("utf8");
  const copyright = [];
  const licenses = [];
  for (const line of text.split(/\r?\n/)) {
    const copyrightMatch = line.match(
      /SPDX-FileCopyrightText:\s*(.+?)(?:\s*-->)?\s*$/,
    );
    if (copyrightMatch) copyright.push(copyrightMatch[1].trim());
    const licenseMatch = line.match(
      /SPDX-License-Identifier:\s*(.+?)(?:\s*-->)?\s*$/,
    );
    if (licenseMatch) licenses.push(licenseMatch[1].trim());
  }
  return { copyright, licenses };
}

function resolveEvidence(annotation, header) {
  const annotationCopyright = normalizeStrings(
    annotation["SPDX-FileCopyrightText"],
  );
  const annotationLicenses = normalizeStrings(
    annotation["SPDX-License-Identifier"],
  );
  const precedence = annotation.precedence ?? "closest";
  if (precedence === "override") {
    return {
      copyright: annotationCopyright,
      licenses: annotationLicenses,
    };
  }
  if (precedence === "aggregate") {
    return {
      copyright: [...new Set([...header.copyright, ...annotationCopyright])],
      licenses: [...new Set([...header.licenses, ...annotationLicenses])],
    };
  }
  if (precedence !== "closest") {
    return {
      error: `unsupported REUSE precedence '${String(precedence)}'`,
      copyright: [],
      licenses: [],
    };
  }
  return {
    copyright:
      header.copyright.length > 0 ? header.copyright : annotationCopyright,
    licenses: header.licenses.length > 0 ? header.licenses : annotationLicenses,
  };
}

function componentOriginIncludes(componentOrigin, fileOrigin) {
  return String(componentOrigin).split("/").includes(fileOrigin);
}

// Attribution describes the retained contributions through the pinned cutoff.
// The separate upstream license copy preserves its publisher's original notice.
// Other publishers may use different year ranges; dates do not set licenses.
function validateNoticeSyntax(file, notices, findings) {
  for (const notice of notices) {
    if (/(?:Myoxus|Daniel Scharf)/i.test(notice) && notice !== MYOXUS_NOTICE) {
      findings.push(
        `${file}: non-canonical or unauthorized Myoxus copyright '${notice}'`,
      );
    }
    if (
      /TOEVERYTHING|upstream authors/i.test(notice) &&
      notice !== UPSTREAM_ATTRIBUTION
    ) {
      findings.push(
        `${file}: upstream attribution does not match the retained contribution period '${notice}'`,
      );
    }
  }
}

function validateOriginEvidence(file, annotation, evidence, findings) {
  const origin = annotation["X-Myoxus-Origin"];
  if (!KNOWN_ORIGINS.has(origin)) {
    findings.push(`${file}: missing or unknown X-Myoxus-Origin '${origin}'`);
    return;
  }
  if (origin === "U0") {
    findings.push(`${file}: unresolved U0 provenance is not release-ready`);
    return;
  }

  validateNoticeSyntax(file, evidence.copyright, findings);
  const notices = new Set(evidence.copyright);
  const licenseText = evidence.licenses.join(" AND ");
  const hasUpstream = notices.has(UPSTREAM_ATTRIBUTION);
  const hasMyoxus = notices.has(MYOXUS_NOTICE);

  if (!LICENSE_FILE_NAMES.has(basename(file)) && notices.size === 0) {
    findings.push(`${file}: missing copyright evidence`);
  }
  if (origin === "F1" || origin === "F2") {
    if (!hasUpstream) {
      findings.push(`${file}: ${origin} removed required upstream attribution`);
    }
    if (
      annotation["X-Myoxus-UpstreamCutoff"] !== CUTOFF_REVISION ||
      annotation["X-Myoxus-UpstreamCutoffDate"] !== CUTOFF_DATE
    ) {
      findings.push(`${file}: ${origin} has wrong or missing upstream cutoff`);
    }
    const declaredMetadataException =
      annotation["X-Myoxus-LicenseException"] === "component-declared" &&
      evidence.licenses.length === 1 &&
      evidence.licenses[0] === "CC0-1.0";
    if (licenseText !== "MIT" && !declaredMetadataException) {
      findings.push(
        `${file}: ${origin} must use MIT for the whole retained file`,
      );
    }
    if (origin === "F2" && hasMyoxus) {
      findings.push(`${file}: F2 cannot assert Myoxus copyright`);
    }
  } else if (origin === "M0" || origin === "C0") {
    if (hasUpstream) {
      findings.push(`${file}: false upstream attribution on ${origin}`);
    }
    if (!hasMyoxus) {
      findings.push(`${file}: ${origin} lacks canonical Myoxus copyright`);
    }
    if (licenseText !== "AGPL-3.0-or-later") {
      findings.push(`${file}: ${origin} must use AGPL-3.0-or-later`);
    }
  } else if (origin === "T1") {
    if (
      hasUpstream ||
      (hasMyoxus &&
        !["MIT", "BSD-3-Clause", "Apache-2.0", "MIT-0"].includes(licenseText))
    ) {
      findings.push(`${file}: T1 has unauthorized upstream/Myoxus attribution`);
    }
    if (notices.size === 0 || evidence.licenses.length === 0) {
      findings.push(`${file}: T1 lacks exact third-party evidence`);
    }
  }
}

export function deterministicAssetHash(repoRoot, files) {
  return sha256(
    files
      .map((file) => `${file}\0${sha256(readFileSync(join(repoRoot, file)))}\n`)
      .join(""),
  );
}

function hasGeneratedSource(repoRoot, files, pattern) {
  if (typeof pattern !== "string") return false;
  if (files.some((file) => pathMatches(file, pattern))) return true;
  // Native document bundles are materialized from Server-owned inputs. Outside
  // the client inventory, require an exact regular file rather than a glob.
  if (
    /[*?\\]/.test(pattern) ||
    pattern.startsWith("/") ||
    pattern.split("/").includes("..")
  ) {
    return false;
  }
  const source = join(repoRoot, pattern);
  return existsSync(source) && lstatSync(source).isFile();
}

function validateManifest(repoRoot, manifest, files, findings) {
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA) {
    findings.push(
      `${MANIFEST_PATH}: schemaVersion must be ${SUPPORTED_SCHEMA}`,
    );
    return;
  }
  const policy = manifest.policy;
  if (!policy || typeof policy !== "object") {
    findings.push(`${MANIFEST_PATH}: policy is required`);
    return;
  }
  if (
    policy.sourceLicensing?.unit !== "file" ||
    policy.sourceLicensing?.retainedMitFileLicense !== "MIT" ||
    policy.sourceLicensing?.newIndependentFileLicense !== "AGPL-3.0-or-later"
  ) {
    findings.push(`${MANIFEST_PATH}: wrong file-level source licensing policy`);
  }
  if (policy.canonicalMyoxusCopyright !== MYOXUS_NOTICE) {
    findings.push(`${MANIFEST_PATH}: wrong canonical Myoxus copyright`);
  }
  if (policy.upstreamCopyright !== UPSTREAM_ATTRIBUTION) {
    findings.push(
      `${MANIFEST_PATH}: wrong retained upstream contribution attribution`,
    );
  }
  if (
    policy.upstreamCutoff?.revision !== CUTOFF_REVISION ||
    policy.upstreamCutoff?.date !== CUTOFF_DATE
  ) {
    findings.push(`${MANIFEST_PATH}: wrong upstream cutoff`);
  }
  if (
    policy.upstreamMitLicense?.path !== UPSTREAM_LICENSE_PATH ||
    policy.upstreamMitLicense?.sha256 !== UPSTREAM_LICENSE_SHA256 ||
    policy.upstreamMitLicense?.originalCopyrightNotice !==
      UPSTREAM_ORIGINAL_NOTICE
  ) {
    findings.push(`${MANIFEST_PATH}: wrong upstream MIT baseline contract`);
  }

  const pathHash = sha256(`${files.join("\n")}\n`);
  if (
    policy.scopedFiles?.pathCount !== files.length ||
    policy.scopedFiles?.pathSha256 !== pathHash
  ) {
    findings.push(
      `${MANIFEST_PATH}: scoped file inventory changed (expected ${String(policy.scopedFiles?.pathCount)}/${String(policy.scopedFiles?.pathSha256)}, got ${files.length}/${pathHash}); explicit review required`,
    );
  }

  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    findings.push(`${MANIFEST_PATH}: non-empty components array is required`);
    return;
  }
  const ids = new Set();
  for (const component of manifest.components) {
    if (!component.id || ids.has(component.id)) {
      findings.push(
        `${MANIFEST_PATH}: missing or duplicate component id '${String(component.id)}'`,
      );
      continue;
    }
    ids.add(component.id);
    if (!Array.isArray(component.paths) || component.paths.length === 0) {
      findings.push(`component ${component.id}: paths must be non-empty`);
    }
    if (!component.origin || !component.licenseExpression) {
      findings.push(
        `component ${component.id}: origin and licenseExpression are required`,
      );
    }
    if (
      !Array.isArray(component.copyrightNotices) ||
      component.copyrightNotices.length === 0
    ) {
      findings.push(
        `component ${component.id}: copyrightNotices must be non-empty`,
      );
    } else {
      validateNoticeSyntax(
        `component ${component.id}`,
        component.copyrightNotices,
        findings,
      );
    }
    if (
      /(?:^|\/)F[12](?:\/|$)/.test(component.origin) &&
      (component.upstreamCutoff?.revision !== CUTOFF_REVISION ||
        component.upstreamCutoff?.date !== CUTOFF_DATE)
    ) {
      findings.push(`component ${component.id}: wrong upstreamCutoff`);
    }
    for (const noticePath of component.noticePaths ?? []) {
      if (!existsSync(join(repoRoot, noticePath))) {
        findings.push(
          `component ${component.id}: noticePath ${noticePath} is missing`,
        );
      }
    }
    if (component.generatedFrom) {
      const generated = component.generatedFrom;
      if (
        typeof generated.generator !== "string" ||
        !existsSync(join(repoRoot, generated.generator))
      ) {
        findings.push(
          `component ${component.id}: generatedFrom.generator is missing`,
        );
      }
      if (
        !Array.isArray(generated.sources) ||
        generated.sources.length === 0 ||
        generated.sources.some(
          (pattern) => !hasGeneratedSource(repoRoot, files, pattern),
        )
      ) {
        findings.push(
          `component ${component.id}: generatedFrom.sources are incomplete`,
        );
      }
    }
  }

  for (const file of files) {
    const matching = manifest.components.filter((component) =>
      component.paths?.some((pattern) => pathMatches(file, pattern)),
    );
    if (matching.length === 0) {
      findings.push(`${file}: not covered by a provenance component`);
    }
    if (
      file.includes("/generated/") &&
      !matching.some((component) => component.generatedFrom)
    ) {
      findings.push(`${file}: unclassified generated output`);
    }
  }

  const packageFiles = files.filter((file) => file.endsWith("/package.json"));
  const expectedPackageLicenses = policy.packageLicenses ?? {};
  for (const packageFile of packageFiles) {
    const expected = expectedPackageLicenses[packageFile];
    const actual = readJson(join(repoRoot, packageFile)).license;
    if (!expected) {
      findings.push(`${packageFile}: package license is not classified`);
    } else if (actual !== expected) {
      findings.push(
        `${packageFile}: package license '${String(actual)}' does not match '${expected}'`,
      );
    }
  }
  for (const packageFile of Object.keys(expectedPackageLicenses)) {
    if (!packageFiles.includes(packageFile)) {
      findings.push(
        `${MANIFEST_PATH}: stale package license entry ${packageFile}`,
      );
    }
  }

  const assetExtensions = new Set(
    (policy.bundledAssets?.extensions ?? []).map((value) => `.${value}`),
  );
  const assets = files.filter((file) =>
    assetExtensions.has(extname(file).toLowerCase()),
  );
  const assetHash = deterministicAssetHash(repoRoot, assets);
  if (
    policy.bundledAssets?.pathCount !== assets.length ||
    policy.bundledAssets?.contentSha256 !== assetHash
  ) {
    findings.push(
      `${MANIFEST_PATH}: unknown bundled asset or bad asset hash (expected ${String(policy.bundledAssets?.pathCount)}/${String(policy.bundledAssets?.contentSha256)}, got ${assets.length}/${assetHash})`,
    );
  }
  const assetComponent = manifest.components.find(
    (component) => component.id === "client-bundled-assets",
  );
  if (
    assets.length > 0 &&
    (!assetComponent || assetComponent.contentSha256 !== assetHash)
  ) {
    findings.push(
      `${MANIFEST_PATH}: client-bundled-assets component is missing or has a bad hash`,
    );
  }
}

function validateBaseline(repoRoot, manifest, findings) {
  const absolute = join(repoRoot, UPSTREAM_LICENSE_PATH);
  if (!existsSync(absolute)) {
    findings.push(
      `${UPSTREAM_LICENSE_PATH}: exact upstream baseline is missing`,
    );
    return;
  }
  const actualHash = sha256(readFileSync(absolute));
  if (
    actualHash !== UPSTREAM_LICENSE_SHA256 ||
    manifest.policy?.upstreamMitLicense?.sha256 !== actualHash
  ) {
    findings.push(
      `${UPSTREAM_LICENSE_PATH}: hash does not match the reviewed fixed-cutoff license copy`,
    );
  }
}

export function validateProvenance(repoRoot) {
  const findings = [];
  const manifestAbsolute = join(repoRoot, MANIFEST_PATH);
  if (!existsSync(manifestAbsolute)) {
    return [`${MANIFEST_PATH}: required provenance manifest is missing`];
  }
  let manifest;
  try {
    manifest = readJson(manifestAbsolute);
  } catch (error) {
    return [`${MANIFEST_PATH}: invalid JSON: ${String(error)}`];
  }
  const roots = manifest.policy?.scopedFiles?.roots;
  if (!Array.isArray(roots) || roots.length === 0) {
    return [`${MANIFEST_PATH}: policy.scopedFiles.roots is required`];
  }
  const files = collectScopedFiles(repoRoot, roots);
  validateManifest(repoRoot, manifest, files, findings);
  validateBaseline(repoRoot, manifest, findings);

  for (const restricted of RESTRICTED_PATHS) {
    if (existsSync(join(repoRoot, restricted))) {
      findings.push(`${restricted}: removed restricted source path returned`);
    }
  }
  const metadataText = [
    readFileSync(manifestAbsolute, "utf8"),
    existsSync(join(repoRoot, REUSE_TOML_PATH))
      ? readFileSync(join(repoRoot, REUSE_TOML_PATH), "utf8")
      : "",
  ].join("\n");
  for (const restricted of RESTRICTED_PATHS) {
    if (metadataText.includes(restricted)) {
      findings.push(
        `${restricted}: removed restricted source path referenced by provenance metadata`,
      );
    }
  }

  let annotations;
  try {
    annotations = loadReuseAnnotations(repoRoot);
  } catch (error) {
    findings.push(String(error));
    return findings;
  }
  for (const annotation of annotations) {
    const paths = annotationPaths(annotation);
    if (paths.length === 0) {
      findings.push(`${REUSE_TOML_PATH}: annotation has no paths`);
    }
    if (paths.some((path) => path.startsWith("client/"))) {
      findings.push(
        `${REUSE_TOML_PATH}: paths are relative to client/ and must not start with client/`,
      );
    }
    if (!annotation["SPDX-License-Identifier"]) {
      findings.push(`${REUSE_TOML_PATH}: annotation lacks a license`);
    }
  }

  for (const file of files) {
    const matches = matchingAnnotations(annotations, file);
    if (matches.length !== 1) {
      findings.push(
        `${file}: expected exactly one path-exact REUSE annotation, found ${matches.length}`,
      );
      continue;
    }
    const annotation = matches[0];
    if (!annotationPaths(annotation).includes(file.slice("client/".length))) {
      findings.push(`${file}: REUSE association is not path-exact`);
    }
    const evidence = resolveEvidence(annotation, parseFileSpdx(repoRoot, file));
    if (evidence.error) findings.push(`${file}: ${evidence.error}`);
    validateOriginEvidence(file, annotation, evidence, findings);
    const origin = annotation["X-Myoxus-Origin"];
    const components = manifest.components.filter((component) =>
      component.paths?.some((pattern) => pathMatches(file, pattern)),
    );
    if (origin === "T1") {
      const originalHolders = new Set(
        components
          .filter((component) =>
            componentOriginIncludes(component.origin, "T1"),
          )
          .flatMap((component) => component.copyrightNotices ?? [])
          .filter(
            (notice) =>
              notice !== MYOXUS_NOTICE && notice !== UPSTREAM_ATTRIBUTION,
          ),
      );
      if (!evidence.copyright.some((notice) => originalHolders.has(notice))) {
        findings.push(
          `${file}: T1 has unauthorized upstream/Myoxus attribution; original holder missing`,
        );
      }
    }
    if (
      KNOWN_ORIGINS.has(origin) &&
      origin !== "U0" &&
      !components.some((component) =>
        componentOriginIncludes(component.origin, origin),
      )
    ) {
      findings.push(
        `${file}: REUSE origin ${origin} is not backed by a matching component`,
      );
    }
    if (
      annotation["X-Myoxus-LicenseException"] &&
      !(manifest.policy.explicitLicenseExceptions ?? []).some(
        (exception) =>
          exception.path === file &&
          exception.decision &&
          exception.licenseExpression === evidence.licenses.join(" AND "),
      )
    ) {
      findings.push(
        `${file}: license exception lacks an explicit owner decision`,
      );
    }
    if (
      annotation["X-Myoxus-LicenseException"] === "component-declared" &&
      !components.some(
        (component) =>
          componentOriginIncludes(component.origin, origin) &&
          evidence.licenses.length === 1 &&
          component.licenseExpression === evidence.licenses[0],
      )
    ) {
      findings.push(
        `${file}: component-declared license exception lacks a matching ${origin}/${evidence.licenses.join(" AND ")} component`,
      );
    }
  }
  return findings;
}

function writeFixture(root, path, value) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}

function fixtureHash(files) {
  return sha256(`${[...files].sort().join("\n")}\n`);
}

function annotation({ paths, origin, notices, license, cutoff = false }) {
  return {
    path: paths.map((path) => path.slice("client/".length)),
    precedence: "override",
    "X-Myoxus-Origin": origin,
    ...(cutoff
      ? {
          "X-Myoxus-UpstreamCutoff": CUTOFF_REVISION,
          "X-Myoxus-UpstreamCutoffDate": CUTOFF_DATE,
        }
      : {}),
    "SPDX-FileCopyrightText": notices,
    "SPDX-License-Identifier": license,
  };
}

function renderFixtureToml(annotations) {
  const lines = ["version = 1", ""];
  for (const item of annotations) {
    lines.push("[[annotations]]");
    for (const [key, value] of Object.entries(item)) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function createCleanFixture() {
  const root = mkdtempSync(join(tmpdir(), "myoxus-client-provenance-"));
  const files = [
    "client/libs/example/changed.ts",
    "client/libs/example/compat.ts",
    "client/libs/example/moved.ts",
    "client/libs/example/new.ts",
    "client/libs/example/package.json",
    "client/libs/example/third-party.ts",
    "client/libs/example/upstream.ts",
  ].sort();
  for (const file of files) {
    writeFixture(
      root,
      file,
      file.endsWith("package.json")
        ? `${JSON.stringify({ name: "@myoxus/example", private: true, license: "AGPL-3.0-or-later" }, null, 2)}\n`
        : "export {};\n",
    );
  }
  const baseline = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../client/provenance/LICENSE-UPSTREAM-MIT.txt",
    ),
  );
  writeFixture(root, UPSTREAM_LICENSE_PATH, baseline);
  const components = [
    {
      id: "fixture-fork",
      paths: [
        "client/libs/example/upstream.ts",
        "client/libs/example/changed.ts",
      ],
      origin: "F1",
      licenseExpression: "MIT",
      copyrightNotices: [UPSTREAM_ATTRIBUTION, MYOXUS_NOTICE],
      upstreamCutoff: { revision: CUTOFF_REVISION, date: CUTOFF_DATE },
      noticePaths: [UPSTREAM_LICENSE_PATH],
    },
    {
      id: "fixture-moved",
      paths: ["client/libs/example/moved.ts"],
      origin: "F2",
      licenseExpression: "MIT",
      copyrightNotices: [UPSTREAM_ATTRIBUTION],
      upstreamCutoff: { revision: CUTOFF_REVISION, date: CUTOFF_DATE },
      noticePaths: [UPSTREAM_LICENSE_PATH],
    },
    {
      id: "fixture-myoxus",
      paths: ["client/libs/example/new.ts", "client/libs/example/package.json"],
      origin: "M0",
      licenseExpression: "AGPL-3.0-or-later",
      copyrightNotices: [MYOXUS_NOTICE],
      noticePaths: ["client/REUSE.toml"],
    },
    {
      id: "fixture-compat",
      paths: ["client/libs/example/compat.ts"],
      origin: "C0",
      licenseExpression: "AGPL-3.0-or-later",
      copyrightNotices: [MYOXUS_NOTICE],
      noticePaths: ["client/REUSE.toml"],
    },
    {
      id: "fixture-google",
      paths: ["client/libs/example/third-party.ts"],
      origin: "T1",
      licenseExpression: "BSD-3-Clause",
      copyrightNotices: [GOOGLE_NOTICE],
      noticePaths: ["client/REUSE.toml"],
    },
  ];
  const manifest = {
    schemaVersion: 1,
    policy: {
      sourceLicensing: {
        unit: "file",
        retainedMitFileLicense: "MIT",
        newIndependentFileLicense: "AGPL-3.0-or-later",
      },
      canonicalMyoxusCopyright: MYOXUS_NOTICE,
      upstreamCopyright: UPSTREAM_ATTRIBUTION,
      upstreamCutoff: { revision: CUTOFF_REVISION, date: CUTOFF_DATE },
      upstreamMitLicense: {
        path: UPSTREAM_LICENSE_PATH,
        sha256: UPSTREAM_LICENSE_SHA256,
        originalCopyrightNotice: UPSTREAM_ORIGINAL_NOTICE,
      },
      scopedFiles: {
        roots: ["client/libs/example"],
        pathCount: files.length,
        pathSha256: fixtureHash(files),
      },
      bundledAssets: {
        extensions: ["png"],
        pathCount: 0,
        contentSha256: sha256(""),
      },
      packageLicenses: {
        "client/libs/example/package.json": "AGPL-3.0-or-later",
      },
    },
    components,
  };
  writeFixture(root, MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  const annotations = [
    annotation({
      paths: ["client/libs/example/upstream.ts"],
      origin: "F1",
      notices: [UPSTREAM_ATTRIBUTION],
      license: "MIT",
      cutoff: true,
    }),
    annotation({
      paths: ["client/libs/example/changed.ts"],
      origin: "F1",
      notices: [UPSTREAM_ATTRIBUTION, MYOXUS_NOTICE],
      license: "MIT",
      cutoff: true,
    }),
    annotation({
      paths: ["client/libs/example/moved.ts"],
      origin: "F2",
      notices: [UPSTREAM_ATTRIBUTION],
      license: "MIT",
      cutoff: true,
    }),
    annotation({
      paths: ["client/libs/example/new.ts", "client/libs/example/package.json"],
      origin: "M0",
      notices: [MYOXUS_NOTICE],
      license: "AGPL-3.0-or-later",
    }),
    annotation({
      paths: ["client/libs/example/compat.ts"],
      origin: "C0",
      notices: [MYOXUS_NOTICE],
      license: "AGPL-3.0-or-later",
    }),
    annotation({
      paths: ["client/libs/example/third-party.ts"],
      origin: "T1",
      notices: [GOOGLE_NOTICE],
      license: "BSD-3-Clause",
    }),
  ];
  writeFixture(root, REUSE_TOML_PATH, renderFixtureToml(annotations));
  return root;
}

function mutateJson(root, path, mutate) {
  const absolute = join(root, path);
  const value = readJson(absolute);
  mutate(value);
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function mutateReuse(root, mutate) {
  const annotations = loadReuseAnnotations(root);
  mutate(annotations);
  writeFixture(root, REUSE_TOML_PATH, renderFixtureToml(annotations));
}

function expectFinding(label, mutate, expected) {
  const root = createCleanFixture();
  try {
    mutate(root);
    const findings = validateProvenance(root);
    if (!findings.some((finding) => finding.includes(expected))) {
      throw new Error(
        `${label} did not produce '${expected}': ${findings.join("; ")}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function applyApacheComponentFixture(root) {
  mutateReuse(root, (entries) => {
    entries[3]["SPDX-License-Identifier"] = "Apache-2.0";
    entries[3]["X-Myoxus-LicenseException"] = "component-declared";
  });
  mutateJson(root, "client/libs/example/package.json", (manifest) => {
    manifest.license = "Apache-2.0";
  });
  mutateJson(root, MANIFEST_PATH, (manifest) => {
    manifest.policy.packageLicenses["client/libs/example/package.json"] =
      "Apache-2.0";
    manifest.components[2].licenseExpression = "Apache-2.0";
  });
}

function applyExternalGeneratorFixture(root) {
  writeFixture(root, "build/generator.mjs", "export {};\n");
  writeFixture(root, "server/templates/source.json", "{}\n");
  mutateJson(root, MANIFEST_PATH, (manifest) => {
    manifest.components[2].generatedFrom = {
      generator: "build/generator.mjs",
      sources: ["server/templates/source.json"],
    };
  });
}

function applyCc0MetadataFixture(root) {
  mutateReuse(root, (entries) => {
    entries[2]["SPDX-License-Identifier"] = "CC0-1.0";
    entries[2]["X-Myoxus-LicenseException"] = "component-declared";
  });
  mutateJson(root, MANIFEST_PATH, (manifest) => {
    manifest.components[1].licenseExpression = "CC0-1.0";
    manifest.policy.explicitLicenseExceptions = [
      {
        path: "client/libs/example/moved.ts",
        licenseExpression: "CC0-1.0",
        decision:
          "Fixture owner explicitly grants CC0 for this metadata source.",
      },
    ];
  });
}

async function selfTest() {
  const positive = createCleanFixture();
  try {
    applyExternalGeneratorFixture(positive);
    applyCc0MetadataFixture(positive);
    const thirdPartyNotice = "2022-2026 Fixture authors";
    mutateReuse(positive, (entries) => {
      entries[5]["SPDX-FileCopyrightText"] = [thirdPartyNotice];
    });
    mutateJson(positive, MANIFEST_PATH, (manifest) => {
      manifest.components[4].copyrightNotices = [thirdPartyNotice];
    });
    const { refreshClientInventories } =
      await import("../release/refresh-source-inventories.mjs");
    refreshClientInventories(positive);
    const findings = validateProvenance(positive);
    if (findings.length > 0) {
      throw new Error(`positive fixture failed: ${findings.join("; ")}`);
    }
  } finally {
    rmSync(positive, { recursive: true, force: true });
  }

  expectFinding(
    "unbacked metadata license exception",
    (root) => {
      applyCc0MetadataFixture(root);
      mutateJson(root, MANIFEST_PATH, (manifest) => {
        manifest.components[1].licenseExpression = "MIT";
      });
    },
    "license exception lacks a matching F2/CC0-1.0 component",
  );
  expectFinding(
    "mixed license on a modified MIT file",
    (root) =>
      mutateReuse(root, (entries) => {
        entries[1]["SPDX-License-Identifier"] = "MIT AND AGPL-3.0-or-later";
      }),
    "F1 must use MIT for the whole retained file",
  );
  expectFinding(
    "package and component cannot relicense new Myoxus source",
    applyApacheComponentFixture,
    "M0 must use AGPL-3.0-or-later",
  );
  expectFinding(
    "missing external generator input",
    (root) => {
      applyExternalGeneratorFixture(root);
      rmSync(join(root, "server/templates/source.json"));
    },
    "generatedFrom.sources are incomplete",
  );

  expectFinding(
    "missing copyright",
    (root) =>
      mutateReuse(root, (entries) => {
        entries[0]["SPDX-FileCopyrightText"] = [];
      }),
    "missing copyright evidence",
  );
  expectFinding(
    "removed upstream attribution",
    (root) =>
      mutateReuse(root, (entries) => {
        entries[0]["SPDX-FileCopyrightText"] = [MYOXUS_NOTICE];
      }),
    "removed required upstream attribution",
  );
  expectFinding(
    "open-ended attribution past the retained cutoff",
    (root) =>
      mutateReuse(root, (entries) => {
        entries[0]["SPDX-FileCopyrightText"] = [UPSTREAM_ORIGINAL_NOTICE];
      }),
    "upstream attribution does not match the retained contribution period",
  );
  expectFinding(
    "false upstream on M0",
    (root) =>
      mutateReuse(root, (entries) => {
        entries[3]["SPDX-FileCopyrightText"] = [
          UPSTREAM_ATTRIBUTION,
          MYOXUS_NOTICE,
        ];
      }),
    "false upstream attribution on M0",
  );
  expectFinding(
    "false upstream on C0",
    (root) =>
      mutateReuse(root, (entries) => {
        entries[4]["SPDX-FileCopyrightText"] = [
          UPSTREAM_ATTRIBUTION,
          MYOXUS_NOTICE,
        ];
      }),
    "false upstream attribution on C0",
  );
  expectFinding(
    "unauthorized Myoxus attribution",
    (root) =>
      mutateReuse(root, (entries) => {
        entries[2]["SPDX-FileCopyrightText"] = [
          UPSTREAM_ATTRIBUTION,
          MYOXUS_NOTICE,
        ];
      }),
    "F2 cannot assert Myoxus copyright",
  );
  expectFinding(
    "missing notice",
    (root) =>
      mutateJson(root, MANIFEST_PATH, (manifest) => {
        manifest.components[0].noticePaths = ["client/MISSING-NOTICE"];
      }),
    "noticePath client/MISSING-NOTICE is missing",
  );
  expectFinding(
    "unknown bundled asset",
    (root) => {
      writeFixture(root, "client/libs/example/unknown.png", "not-a-png");
    },
    "unknown bundled asset",
  );
  expectFinding(
    "bad asset hash",
    (root) =>
      mutateJson(root, MANIFEST_PATH, (manifest) => {
        manifest.policy.bundledAssets.contentSha256 = "0".repeat(64);
      }),
    "bad asset hash",
  );
  expectFinding(
    "unclassified generated output",
    (root) => {
      writeFixture(
        root,
        "client/libs/example/generated/index.ts",
        "export {};\n",
      );
    },
    "unclassified generated output",
  );
  expectFinding(
    "restricted source",
    (root) => {
      writeFixture(root, "packages/backend/secret.ts", "export {};\n");
    },
    "removed restricted source path returned",
  );
  expectFinding(
    "wrong blanket license",
    (root) =>
      mutateReuse(root, (entries) => {
        entries[3]["SPDX-License-Identifier"] = "MIT";
      }),
    "M0 must use AGPL-3.0-or-later",
  );
  expectFinding(
    "wrong upstream license bytes",
    (root) => {
      writeFixture(root, UPSTREAM_LICENSE_PATH, "not the upstream license\n");
    },
    "hash does not match",
  );
  console.log("verify-client-source-provenance self-test passed.");
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.argv.includes("--self-test")) {
    selfTest().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  } else {
    const findings = validateProvenance(process.cwd());
    if (findings.length > 0) {
      console.error("Client source provenance violations:");
      for (const finding of findings) console.error(`- ${finding}`);
      process.exitCode = 1;
    } else {
      console.log(
        "Client source provenance valid: exact copyright, license, cutoff, component, asset and package evidence resolved.",
      );
    }
  }
}
