// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

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
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(repoRoot, "package.json"));
const { parse: parseYaml } = require("yaml");

const PHASE_ID = "P-ELECTRON-BUILD-00";
const outputRoot = join(repoRoot, "output/electron-build", PHASE_ID);
const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "fs/promises",
]);

const args = new Set(process.argv.slice(2));
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function command(commandName, commandArgs) {
  return execFileSync(commandName, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
}

function updateMetadataContract() {
  const expected = {
    owner: "myoxus",
    repo: "packages",
    provider: "custom",
    private: false,
  };
  return ["client/apps/electron/resources/templates/app-update.yml"].map(
    (path) => {
      const value = parseYaml(readFileSync(join(repoRoot, path), "utf8"));
      for (const [key, expectedValue] of Object.entries(expected)) {
        if (value?.[key] !== expectedValue) {
          throw new Error(
            `${path} must set ${key}=${JSON.stringify(expectedValue)} for the canonical myoxus/packages release target`,
          );
        }
      }
      return { path, ...expected };
    },
  );
}

function walkFiles(root, { includeGenerated = false } = {}) {
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];
  const files = [];
  const ignored = new Set([
    ".git",
    ".yarn",
    "node_modules",
    ...(includeGenerated ? [] : ["dist", "lib", "out", "target"]),
  ]);

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile())
        files.push(normalizePath(relative(repoRoot, path)));
    }
  }

  visit(absoluteRoot);
  return files.sort();
}

function moduleName(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    builtins.has(specifier)
  ) {
    return null;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

function importsFor(paths) {
  const imports = new Map();
  const importPattern =
    /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s+)["']([^"']+)["']/g;
  for (const path of paths) {
    if (!sourceExtensions.has(extname(path))) continue;
    const source = readFileSync(join(repoRoot, path), "utf8");
    for (const match of source.matchAll(importPattern)) {
      const name = moduleName(match[1]);
      if (!name) continue;
      const owners = imports.get(name) ?? new Set();
      owners.add(path);
      imports.set(name, owners);
    }
  }
  return Object.fromEntries(
    [...imports.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, owners]) => [name, [...owners].sort()]),
  );
}

function withManifestExecutables(imports, executables) {
  const merged = new Map(
    Object.entries(imports).map(([name, owners]) => [name, new Set(owners)]),
  );
  for (const [name, owner] of Object.entries(executables)) {
    const owners = merged.get(name) ?? new Set();
    owners.add(owner);
    merged.set(name, owners);
  }
  return Object.fromEntries(
    [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, owners]) => [name, [...owners].sort()]),
  );
}

function lockGraph(resolutions) {
  const lock = parseYaml(readFileSync(join(repoRoot, "yarn.lock"), "utf8"));
  const descriptorIndex = new Map();
  const entries = [];
  for (const [descriptors, entry] of Object.entries(lock)) {
    if (descriptors === "__metadata") continue;
    const normalizedEntry = {
      descriptors: descriptors.split(", ").sort(),
      resolution: entry.resolution,
      version: entry.version,
      dependencies: entry.dependencies ?? {},
    };
    entries.push(normalizedEntry);
    for (const descriptor of normalizedEntry.descriptors) {
      descriptorIndex.set(descriptor, normalizedEntry);
    }
  }
  return { descriptorIndex, entries, resolutions };
}

function descriptorFor(name, range, graph) {
  const normalizedRange =
    typeof range === "string" && range.startsWith("npm:")
      ? range.slice("npm:".length)
      : range;
  const override =
    graph.resolutions?.[`${name}@${range}`] ??
    graph.resolutions?.[`${name}@npm:${normalizedRange}`] ??
    graph.resolutions?.[name];
  const requestedRanges = [range, override].filter(Boolean);
  const exact = [
    ...requestedRanges.map((value) => `${name}@${value}`),
    ...requestedRanges
      .filter((value) => typeof value === "string" && !value.includes(":"))
      .map((value) => `${name}@npm:${value}`),
  ]
    .map((descriptor) => graph.descriptorIndex.get(descriptor))
    .find(Boolean);
  if (exact) return exact;
  const candidates = graph.entries.filter((entry) =>
    entry.descriptors.some((descriptor) => descriptor.startsWith(`${name}@`)),
  );
  const unique = new Map(candidates.map((entry) => [entry.resolution, entry]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function resolveClosure(imports, manifests, graph, category) {
  const queue = Object.keys(imports).map((name) => ({
    name,
    range: manifests[name],
  }));
  const resolutions = new Map();
  const unmapped = new Map();

  while (queue.length) {
    const current = queue.shift();
    const entry = descriptorFor(current.name, current.range, graph);
    if (!entry) {
      const finding = {
        category,
        name: current.name,
        range: current.range ?? null,
      };
      unmapped.set(`${finding.name}:${finding.range}`, finding);
      continue;
    }
    if (resolutions.has(entry.resolution)) continue;
    resolutions.set(entry.resolution, {
      resolution: entry.resolution,
      version: entry.version,
    });
    for (const [name, range] of Object.entries(entry.dependencies)) {
      queue.push({ name, range });
    }
  }

  return {
    directImports: imports,
    locators: [...resolutions.values()].sort((left, right) =>
      left.resolution.localeCompare(right.resolution),
    ),
    unmapped: [...unmapped.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

function lineMatches(path, pattern) {
  return readFileSync(join(repoRoot, path), "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) =>
      pattern.test(line) ? [{ line: index + 1, text: line.trim() }] : [],
    );
}

function privateUpdaterImports() {
  return walkFiles("client/apps/electron")
    .filter((path) => sourceExtensions.has(extname(path)))
    .flatMap((path) =>
      lineMatches(path, /electron-updater\/out\//).map((match) => ({
        path,
        ...match,
      })),
    );
}

function unknownPrivateUpdaterImports(imports) {
  return imports;
}

function rendererViolationsFromFiles(files) {
  const forbidden = /^(?:electron|node:|fs(?:\/|$)|child_process(?:\/|$))/;
  const violations = [];
  for (const path of files) {
    if (!sourceExtensions.has(extname(path))) continue;
    const source = readFileSync(
      path.startsWith("/") ? path : join(repoRoot, path),
      "utf8",
    );
    const importPattern =
      /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s+)["']([^"']+)["']/g;
    for (const match of source.matchAll(importPattern)) {
      if (
        forbidden.test(match[1]) ||
        match[1].includes("apps/electron/src/main")
      ) {
        violations.push({ path: normalizePath(path), specifier: match[1] });
      }
    }
  }
  return violations;
}

function outputInventory(path) {
  const absolute = join(repoRoot, path);
  if (!existsSync(absolute))
    return { exists: false, fileCount: 0, totalBytes: 0 };
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        files.push({
          path: normalizePath(relative(absolute, entryPath)),
          size: statSync(entryPath).size,
        });
      }
    }
  }
  visit(absolute);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    exists: true,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    inventorySha256: sha256(stableJson(files)),
  };
}

function nativeBindings() {
  const roots = [
    "client/libs/crypto",
    "client/libs/media-capture",
    "client/libs/local-store",
    "client/apps/electron/dist",
  ];
  return roots
    .flatMap((root) => walkFiles(root, { includeGenerated: true }))
    .filter((path) => path.endsWith(".node"))
    .map((path) => ({ path, size: statSync(join(repoRoot, path)).size }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

const squirrelDocumentationContracts = [
  /No Squirrel package detection/i,
  /No Squirrel package or$/i,
  /Squirrel is unsupported/i,
  /Squirrel backend are not$/i,
  /rejects Squirrel/i,
  /Squirrel files, packages, and private/i,
  /Squirrel is not a supported/i,
  /Squirrel\/NUPKG\/RELEASES artifact/i,
];

function squirrelReferenceDisposition(path, text) {
  if (path === ".yarnrc.yml" && text === "electron-builder-squirrel-windows:") {
    return "upstream-app-builder-optional-peer-disablement";
  }
  if (
    path === "yarn.lock" &&
    text === "electron-builder-squirrel-windows: 26.15.3"
  ) {
    return "upstream-app-builder-optional-peer-metadata";
  }
  if (
    path.startsWith("docs/") &&
    squirrelDocumentationContracts.some((pattern) => pattern.test(text))
  ) {
    return "negative-documentation-contract";
  }
  if (
    path === "client/apps/electron/scripts/lib/packaging-runner.ts" &&
    text.startsWith("/^(?:RELEASES") &&
    text.endsWith("/i;")
  ) {
    return "artifact-rejection-source";
  }
  if (
    path === "client/apps/electron/src/main/updater/update-manifest.ts" &&
    (text.startsWith("/squirrel|\\.nupkg$/i.test") ||
      text.includes("contains forbidden Squirrel asset"))
  ) {
    return "update-feed-rejection-source";
  }
  if (
    path === "client/apps/electron/test/build/packaging-config.spec.ts" &&
    (text.includes("rejects Squirrel output before replacement") ||
      text === '"myoxus-full.nupkg",')
  ) {
    return "negative-packaging-fixture";
  }
  if (
    path === "client/apps/electron/test/main/updater.spec.ts" &&
    (text.includes("rejects every Squirrel release marker") ||
      text === '"myoxus-0.42.0-full.nupkg",' ||
      text === '"squirrel.exe",')
  ) {
    return "negative-updater-fixture";
  }
  return null;
}

function squirrelInventory(extraEntries = []) {
  const scopes = [
    ".yarnrc.yml",
    "package.json",
    "yarn.lock",
    "client/apps/electron",
    "build/scripts/electron",
    ".forgejo/workflows",
    "docs/dev/app",
    "docs/ops",
  ];
  const files = scopes.flatMap((scope) => {
    const absolute = join(repoRoot, scope);
    if (!existsSync(absolute)) return [];
    return lstatSync(absolute).isDirectory() ? walkFiles(scope) : [scope];
  });
  const pattern = /squirrel|electron-winstaller|nupkg/i;
  const entries = [...extraEntries];
  for (const path of [...new Set(files)].sort()) {
    if (
      !sourceExtensions.has(extname(path)) &&
      !/[.](json|md|ya?ml)$/.test(path) &&
      path !== "yarn.lock"
    ) {
      continue;
    }
    for (const match of lineMatches(path, pattern)) {
      entries.push({ path, ...match });
    }
  }
  return entries
    .map((entry) => ({
      ...entry,
      disposition: squirrelReferenceDisposition(entry.path, entry.text),
    }))
    .sort((left, right) =>
      `${left.path}:${left.line}`.localeCompare(`${right.path}:${right.line}`),
    );
}

function activeSquirrelPackagingInventory(extraEntries = []) {
  const files = [
    "client/apps/electron/package.json",
    ...walkFiles("client/apps/electron/scripts/packaging"),
  ];
  const pattern =
    /electron-winstaller|maker-squirrel|make-squirrel|(?:target|artifactName)[^\n]*(?:squirrel|nupkg|RELEASES)/i;
  return [
    ...extraEntries,
    ...files.flatMap((path) =>
      lineMatches(path, pattern).map((match) => ({ path, ...match })),
    ),
  ].sort((left, right) =>
    `${left.path}:${left.line}`.localeCompare(`${right.path}:${right.line}`),
  );
}

function parseAudit(path, closure) {
  if (!path) return { status: "not-run", advisories: [], invalidLines: 0 };
  const resolutionsByName = new Map();
  for (const [category, value] of Object.entries(closure)) {
    for (const locator of value.locators) {
      const match = locator.resolution.match(/^(?<name>@[^/]+\/[^@]+|[^@]+)@/);
      if (!match?.groups?.name) continue;
      const categories = resolutionsByName.get(match.groups.name) ?? new Set();
      categories.add(category);
      resolutionsByName.set(match.groups.name, categories);
    }
  }
  const advisories = [];
  let invalidLines = 0;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const issue = event.children?.Issue;
    const severity = event.children?.Severity;
    if (!issue || !severity || typeof event.value !== "string") continue;
    const name = event.value.split(/\s+-\s+/, 1)[0].trim();
    advisories.push({
      name,
      issue,
      severity,
      closure: [...(resolutionsByName.get(name) ?? [])].sort(),
      classification: resolutionsByName.has(name)
        ? "electron-closure"
        : "repository-only",
    });
  }
  return {
    status: "captured",
    invalidLines,
    advisories: advisories.sort((left, right) =>
      `${left.name}:${left.issue}`.localeCompare(
        `${right.name}:${right.issue}`,
      ),
    ),
  };
}

function validateFeedPayload(payload) {
  if (!Array.isArray(payload)) throw new Error("release feed must be an array");
  return payload.map((release, releaseIndex) => {
    if (!release || typeof release !== "object" || Array.isArray(release)) {
      throw new Error(`release[${releaseIndex}] must be an object`);
    }
    for (const key of ["tag_name", "name", "body", "published_at"]) {
      if (typeof release[key] !== "string") {
        throw new Error(`release[${releaseIndex}].${key} must be a string`);
      }
    }
    for (const key of ["draft", "prerelease"]) {
      if (typeof release[key] !== "boolean") {
        throw new Error(`release[${releaseIndex}].${key} must be a boolean`);
      }
    }
    if (!Array.isArray(release.assets)) {
      throw new Error(`release[${releaseIndex}].assets must be an array`);
    }
    const assets = (release.assets ?? []).map((asset, assetIndex) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        throw new Error(
          `release[${releaseIndex}].assets[${assetIndex}] must be an object`,
        );
      }
      for (const key of ["name", "browser_download_url"]) {
        if (typeof asset[key] !== "string") {
          throw new Error(`asset[${assetIndex}].${key} must be a string`);
        }
      }
      return {
        name: asset.name ?? null,
        browserDownloadUrl: asset.browser_download_url ?? null,
      };
    });
    return {
      tagName: release.tag_name ?? null,
      name: release.name ?? null,
      draft: release.draft ?? null,
      prerelease: release.prerelease ?? null,
      assets,
    };
  });
}

async function refreshFeeds() {
  const result = {};
  const url = new URL(
    "https://git.blume29.de/api/v1/repos/myoxus/packages/releases?page=1&limit=50",
  );
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.url && new URL(response.url).origin !== url.origin) {
      throw new Error(`origin changed to ${new URL(response.url).origin}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`redirect status ${response.status}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    const payload = JSON.parse(body);
    result.forgejo = {
      status: "valid",
      httpStatus: response.status,
      payloadSha256: sha256(body),
      snapshot: validateFeedPayload(payload),
    };
  } catch (error) {
    result.forgejo = {
      status: "blocked",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, "feed-contracts.json"), stableJson(result));
  return result;
}

function existingFeeds() {
  const path = join(outputRoot, "feed-contracts.json");
  return existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { status: "not-captured" };
}

function packageLayoutContract() {
  const sourceOutput = "client/apps/electron/resources/web-static";
  if (existsSync(join(repoRoot, sourceOutput))) {
    throw new Error(`${sourceOutput} must never be a generated source output`);
  }

  const distPrefix = "client/apps/electron/dist/";
  const allowedDist =
    /^(?:main|preload|helper)[.]js(?:[.]map)?$|^[^/]+[.]node$/;
  const invalidDist = walkFiles("client/apps/electron/dist", {
    includeGenerated: true,
  }).filter((path) => !allowedDist.test(path.slice(distPrefix.length)));
  if (invalidDist.length) {
    throw new Error(
      `Electron dist contains non-runtime artifacts: ${invalidDist.join(", ")}`,
    );
  }

  const stagePrefix = "client/apps/electron/out/";
  const forbiddenStage = walkFiles("client/apps/electron/out", {
    includeGenerated: true,
  })
    .filter((path) => path.includes("/stage/"))
    .filter((path) => {
      const relativePath = path.slice(stagePrefix.length);
      return (
        relativePath.endsWith(".map") ||
        relativePath
          .split("/")
          .some(
            (segment) => segment === "node_modules" || segment.startsWith("."),
          )
      );
    });
  if (forbiddenStage.length) {
    throw new Error(
      `Electron stage contains forbidden artifacts: ${forbiddenStage.join(", ")}`,
    );
  }

  return {
    status: "must-pass",
    negativeFixture: "client/apps/electron/test/build/package-layout.spec.ts",
    sourceOutputAbsent: true,
    invalidDist,
    forbiddenStage,
  };
}

function runSelfTests() {
  const directory = mkdtempSync(join(tmpdir(), "myoxus-electron-baseline-"));
  try {
    const rendererFixture = join(directory, "renderer.ts");
    writeFileSync(rendererFixture, 'import "electron";\n');
    if (rendererViolationsFromFiles([rendererFixture]).length !== 1) {
      throw new Error("renderer boundary negative fixture did not fail");
    }
    if (rendererViolationsFromFiles([]).length !== 0) {
      throw new Error("empty renderer boundary fixture failed");
    }
    const unknownSquirrel = squirrelInventory([
      { path: "unknown/new-adapter.ts", line: 1, text: "Squirrel adapter" },
    ]);
    if (!unknownSquirrel.some((entry) => entry.disposition === null)) {
      throw new Error("unknown Squirrel reference fixture did not fail");
    }
    const negativeSquirrelContract = squirrelInventory([
      {
        path: "client/apps/electron/test/main/updater.spec.ts",
        line: 1,
        text: 'it("rejects every Squirrel release marker", () => {',
      },
    ]);
    if (
      !negativeSquirrelContract.some(
        (entry) =>
          entry.path === "client/apps/electron/test/main/updater.spec.ts" &&
          entry.line === 1 &&
          entry.disposition === "negative-updater-fixture",
      )
    ) {
      throw new Error("explicit negative Squirrel contract was not classified");
    }
    if (
      activeSquirrelPackagingInventory([
        {
          path: "client/apps/electron/scripts/packaging/fixture.ts",
          line: 1,
          text: 'artifactName: "client-full.nupkg"',
        },
      ]).length !== 1
    ) {
      throw new Error("active Squirrel package target fixture did not fail");
    }
    if (
      unknownPrivateUpdaterImports([
        {
          path: "client/apps/electron/src/main/new-updater.ts",
          text: 'import "electron-updater/out/private";',
        },
      ]).length !== 1
    ) {
      throw new Error("unknown private updater import fixture did not fail");
    }
    const auditFixture = join(directory, "audit.ndjson");
    writeFileSync(
      auditFixture,
      [
        JSON.stringify({
          value: "electron - vulnerable fixture",
          children: { Issue: "GHSA-fixture", Severity: "high" },
        }),
        "invalid-json",
      ].join("\n"),
    );
    const audit = parseAudit(auditFixture, {
      runtime: {
        locators: [{ resolution: "electron@npm:41.3.0" }],
      },
    });
    if (
      audit.invalidLines !== 1 ||
      audit.advisories[0]?.classification !== "electron-closure"
    ) {
      throw new Error("audit classification negative fixture did not fail");
    }
    const executableImports = withManifestExecutables(
      { "cross-env": ["scripts/build.ts"] },
      {
        "cross-env": "client/apps/electron/package.json#scripts.build",
        "@electron/packager":
          "client/apps/electron/package.json#devDependencies.@electron/packager",
      },
    );
    if (
      executableImports["cross-env"]?.length !== 2 ||
      executableImports["@electron/packager"]?.length !== 1
    ) {
      throw new Error(
        "manifest executable fixture did not preserve object-shaped import ownership",
      );
    }
    for (const payload of ["<html>", "{}", '[{"tag_name":42}]']) {
      let failed = false;
      try {
        validateFeedPayload(JSON.parse(payload));
      } catch {
        failed = true;
      }
      if (!failed)
        throw new Error(`invalid feed fixture was accepted: ${payload}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function markdownReport(report) {
  const lines = [
    `# Electron build baseline - ${PHASE_ID}`,
    "",
    `- Commit: \`${report.environment.commit}\``,
    `- Platform: \`${report.environment.platform}/${report.environment.arch}\``,
    `- Node: \`${report.environment.node}\``,
    `- Package layout: \`${report.packageLayout.status}\``,
    `- Private updater imports: ${report.privateUpdaterImports.length}`,
    `- Explicit negative Squirrel references: ${report.squirrel.negativeReferences.length}`,
    `- Native bindings present: ${report.nativeBindings.length}`,
    "",
    "## Feed contract",
    "",
    `- Forgejo myoxus/packages: \`${report.feeds.forgejo?.status ?? report.feeds.status}\``,
    "",
    "## Output inventory",
    "",
  ];
  for (const [path, inventory] of Object.entries(report.outputs)) {
    lines.push(
      `- \`${path}\`: ${inventory.fileCount} files, ${inventory.totalBytes} bytes`,
    );
  }
  return `${lines.join("\n")}\n`;
}

runSelfTests();
const electronManifest = readJson("client/apps/electron/package.json");
const rootManifest = readJson("package.json");
const manifestRanges = {
  ...rootManifest.dependencies,
  ...rootManifest.devDependencies,
  ...electronManifest.dependencies,
  ...electronManifest.devDependencies,
};
const graph = lockGraph(rootManifest.resolutions);
const importGroups = {
  runtime: importsFor(walkFiles("client/apps/electron/src")),
  releaseBuild: withManifestExecutables(
    importsFor(walkFiles("client/apps/electron/scripts")),
    {
      "cross-env": "client/apps/electron/package.json#scripts",
    },
  ),
  testTooling: importsFor([
    ...walkFiles("client/apps/electron/test"),
    "client/apps/electron/vitest.config.mts",
  ]),
};
const closure = Object.fromEntries(
  Object.entries(importGroups).map(([category, imports]) => [
    category,
    resolveClosure(imports, manifestRanges, graph, category),
  ]),
);
const squirrelReferences = squirrelInventory();
const activeSquirrelPackaging = activeSquirrelPackagingInventory();
const updaterImports = privateUpdaterImports();
const rendererViolations = rendererViolationsFromFiles(
  walkFiles("client/apps/electron-renderer/src"),
);
const updateMetadata = updateMetadataContract();
const feeds = args.has("--refresh-feeds")
  ? await refreshFeeds()
  : existingFeeds();
const packageLayout = packageLayoutContract();
const defaultAuditPath = join(outputRoot, "yarn-audit.ndjson");
const auditPath =
  option("--audit-file") ??
  (existsSync(defaultAuditPath) ? defaultAuditPath : undefined);
const report = {
  schema: "myoxus-electron-build-baseline",
  environment: {
    branch: command("git", ["branch", "--show-current"]),
    commit: command("git", ["rev-parse", "HEAD"]),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    yarn: command("yarn", ["--version"]),
    rust: command("rustc", ["--version"]),
    environmentGate: "completed",
  },
  manifests: {
    rootVersion: rootManifest.version,
    electron: electronManifest,
    renderer: readJson("client/apps/electron-renderer/package.json"),
    desktopContract: readJson("client/libs/desktop-api-contract/package.json"),
  },
  closure,
  audit: parseAudit(auditPath, closure),
  privateUpdaterImports: updaterImports,
  updateMetadata,
  rendererViolations,
  nativeBindings: nativeBindings(),
  packageTargets: Object.keys(electronManifest.scripts)
    .filter((name) => /^(?:package|make)/.test(name))
    .sort(),
  outputs: Object.fromEntries(
    [
      "client/apps/electron/dist",
      "client/apps/electron/lib/tsc",
      "client/apps/electron/out",
      "client/apps/electron-renderer/dist",
    ].map((path) => [path, outputInventory(path)]),
  ),
  packageLayout,
  squirrel: {
    target:
      "NSIS installable; ZIP portable; no installed Squirrel package or backend; explicit rejection contracts only",
    negativeReferences: squirrelReferences,
    activePackaging: activeSquirrelPackaging,
  },
  feeds,
};

const findings = [
  ...rendererViolations.map(
    (value) => `renderer boundary: ${value.path} -> ${value.specifier}`,
  ),
  ...Object.values(closure).flatMap((value) =>
    value.unmapped.map(
      (entry) => `unmapped ${entry.category} import: ${entry.name}`,
    ),
  ),
  ...squirrelReferences
    .filter((entry) => !entry.disposition)
    .map(
      (entry) =>
        `Squirrel reference is not an explicit negative contract: ${entry.path}:${entry.line}`,
    ),
  ...activeSquirrelPackaging.map(
    (entry) =>
      `active Squirrel packaging target: ${entry.path}:${entry.line} ${entry.text}`,
  ),
  ...unknownPrivateUpdaterImports(updaterImports).map(
    (entry) =>
      `unknown private updater import: ${entry.path}:${entry.line} ${entry.text}`,
  ),
  ...(report.audit.invalidLines > 0
    ? [`audit contains ${report.audit.invalidLines} invalid JSON lines`]
    : []),
];

mkdirSync(outputRoot, { recursive: true });
const serialized = stableJson(report);
const reportPath = join(outputRoot, "baseline.json");
if (args.has("--check-stable") && existsSync(reportPath)) {
  const previous = readFileSync(reportPath, "utf8");
  if (previous !== serialized) {
    throw new Error("Electron baseline report is not byte-stable");
  }
}
writeFileSync(reportPath, serialized);
writeFileSync(join(outputRoot, "baseline.md"), markdownReport(report));
writeFileSync(
  join(outputRoot, "run-metadata.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), checkout: repoRoot }, null, 2)}\n`,
);

if (findings.length) {
  console.error("Electron build baseline findings:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `Electron build baseline valid: ${report.nativeBindings.length} native files, ${report.privateUpdaterImports.length} private updater imports, ${squirrelReferences.length} explicit negative Squirrel references; package_layout=${report.packageLayout.status}.`,
);
