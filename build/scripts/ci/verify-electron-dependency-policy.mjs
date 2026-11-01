// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectModuleReferences } from "./source-imports.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(repoRoot, "package.json"));
const { parse: parseYaml } = require("yaml");
const outputRoot = join(repoRoot, "output/electron-build/P-ELECTRON-BUILD-01");
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
const exactVersions = new Map([
  ["electron", "44.5.0"],
  ["@electron/packager", "20.3.0"],
  ["@sentry/electron", "7.20.0"],
  ["@sentry/bundler-plugins", "10.75.0"],
  ["vitest", "4.1.11"],
  ["@vitest/browser-playwright", "4.1.11"],
  ["@vitest/coverage-istanbul", "4.1.11"],
  ["@vitest/ui", "4.1.11"],
  ["vite", "8.3.1"],
  ["vite-plugin-wasm", "3.6.0"],
  ["typescript", "7.0.2"],
  ["lodash-es", "4.18.1"],
  ["builder-util-runtime", "9.7.0"],
  ["electron-log", "5.4.4"],
  ["electron-updater", "6.8.9"],
]);
const prohibitedDirectDependencies = new Set([
  "app-builder-lib",
  "dmg-builder",
  "@typescript/native",
  "@typescript/native-preview",
  "@typescript/typescript6",
  "@vitest/browser",
]);
const exactRootResolutions = new Map([
  ["dompurify@npm:^3.3.3", "npm:3.4.16"],
  ["js-yaml@npm:^4.1.0", "npm:4.3.2"],
  ["js-yaml@npm:^4.2.0", "npm:4.3.2"],
  ["nanoid@npm:^3.3.16", "npm:3.3.18"],
  ["vite@npm:^6.0.0 || ^7.0.0 || ^8.0.0", "npm:8.3.1"],
]);
const prohibitedPolicyKeys = new Set([
  "advisoryAllowlist",
  "auditAllowlist",
  "auditExceptions",
  "auditIgnoreAdvisories",
  "ignoredAdvisories",
]);
const electron44RemovedMainApiPatterns = [
  ["app.isUnityRunning()", /\bapp\s*[.]\s*isUnityRunning\s*[(]/],
  [
    "removed clipboard helper",
    /\bclipboard\s*[.]\s*(?:availableFormats|readBookmark|readBuffer|readFindText|readHTML|readImage|readRTF|writeBookmark|writeBuffer|writeFindText|writeHTML|writeImage|writeRTF)\s*[(]/,
  ],
];

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

function walkFiles(root, predicate = () => true) {
  const files = [];
  const ignored = new Set([
    ".git",
    ".yarn",
    "dist",
    "lib",
    "node_modules",
    "out",
    "output",
    "target",
    "test-results",
  ]);
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  }
  visit(join(repoRoot, root));
  return files.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
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

function importsFor(files) {
  const imports = new Set();
  for (const path of files) {
    if (!sourceExtensions.has(extname(path))) continue;
    const source = readFileSync(path, "utf8");
    for (const { specifier } of collectModuleReferences(path, source)) {
      const name = moduleName(specifier);
      if (name) imports.add(name);
    }
  }
  return [...imports].sort();
}

function packageNameFromLocator(locator) {
  const match = locator.match(/^(@[^/]+\/[^@]+|[^@]+)@/);
  return match?.[1] ?? null;
}

function lockGraph() {
  const lock = parseYaml(readFileSync(join(repoRoot, "yarn.lock"), "utf8"));
  const descriptorIndex = new Map();
  const entries = [];
  for (const [descriptors, value] of Object.entries(lock)) {
    if (descriptors === "__metadata") continue;
    const entry = {
      descriptors: descriptors.split(", ").sort(),
      resolution: value.resolution,
      version: String(value.version),
      dependencies: value.dependencies ?? {},
    };
    entries.push(entry);
    for (const descriptor of entry.descriptors) {
      descriptorIndex.set(descriptor, entry);
    }
  }
  return { descriptorIndex, entries };
}

function descriptorFor(name, range, graph, resolutions) {
  const normalizedRange = range?.startsWith("npm:")
    ? range.slice("npm:".length)
    : range;
  const override =
    resolutions?.[`${name}@${range}`] ??
    resolutions?.[`${name}@npm:${normalizedRange}`] ??
    resolutions?.[name];
  const requested = [range, override].filter(Boolean);
  for (const descriptor of [
    ...requested.map((value) => `${name}@${value}`),
    ...requested
      .filter((value) => !value.includes(":"))
      .map((value) => `${name}@npm:${value}`),
  ]) {
    const exact = graph.descriptorIndex.get(descriptor);
    if (exact) return exact;
  }
  const candidates = new Map(
    graph.entries
      .filter((entry) =>
        entry.descriptors.some((descriptor) =>
          descriptor.startsWith(`${name}@`),
        ),
      )
      .map((entry) => [entry.resolution, entry]),
  );
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

function workspacePackages() {
  const packages = new Map();
  for (const manifestPath of walkFiles(".", (path) =>
    path.endsWith("package.json"),
  )) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.name) continue;
    const workspaceRoot = dirname(manifestPath);
    const sourceFiles = walkFiles(
      relative(repoRoot, join(workspaceRoot, "src")),
    ).filter((path) => {
      const segments = relative(repoRoot, path).split(/[\\/]/);
      return (
        !segments.some((segment) =>
          ["__tests__", "fixtures", "test-utils"].includes(segment),
        ) && !/[.](?:bench|spec|test)[.][cm]?[jt]sx?$/.test(path)
      );
    });
    packages.set(manifest.name, {
      imports: importsFor(sourceFiles),
      ranges: {
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
        ...manifest.devDependencies,
      },
    });
  }
  return packages;
}

function resolveClosure(
  names,
  ranges,
  graph,
  resolutions,
  workspaces,
  category,
) {
  const queue = names.map((name) => ({
    name,
    parent: `<${category}-import>`,
    range: ranges[name],
  }));
  const locators = new Map();
  const unmapped = new Map();
  while (queue.length) {
    const current = queue.shift();
    const entry = descriptorFor(
      current.name,
      current.range,
      graph,
      resolutions,
    );
    if (!entry) {
      unmapped.set(`${current.name}:${current.range}`, {
        category,
        name: current.name,
        range: current.range ?? null,
      });
      continue;
    }
    if (locators.has(entry.resolution)) continue;
    locators.set(entry.resolution, {
      name: packageNameFromLocator(entry.resolution),
      parent: current.parent,
      requestedRange: current.range ?? null,
      resolution: entry.resolution,
      version: entry.version,
    });
    if (entry.resolution.includes("@workspace:")) {
      const workspace = workspaces.get(current.name);
      if (!workspace) {
        unmapped.set(`workspace:${current.name}`, {
          category,
          name: current.name,
          range: current.range ?? null,
        });
        continue;
      }
      for (const name of workspace.imports) {
        queue.push({
          name,
          parent: entry.resolution,
          range: workspace.ranges[name],
        });
      }
    } else {
      for (const [name, range] of Object.entries(entry.dependencies)) {
        queue.push({ name, parent: entry.resolution, range });
      }
    }
  }
  return {
    category,
    directImports: names,
    locators: [...locators.values()].sort((left, right) =>
      left.resolution.localeCompare(right.resolution),
    ),
    unmapped: [...unmapped.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

function findProhibitedKeys(value, path = "$") {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(prohibitedPolicyKeys.has(key) ? [`${path}.${key}`] : []),
    ...findProhibitedKeys(entry, `${path}.${key}`),
  ]);
}

function auditEvents(text) {
  const events = [];
  const invalid = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        typeof event.value === "string" &&
        typeof event.children?.Issue === "string" &&
        typeof event.children?.Severity === "string"
      ) {
        events.push(event);
      }
    } catch {
      invalid.push(index + 1);
    }
  }
  return { events, invalid };
}

function classifyAudit(events, graph, locatorCategories) {
  const findings = [];
  const advisories = [];
  for (const event of events) {
    const name = event.value.split(/\s+-\s+/, 1)[0].trim();
    const versions = Array.isArray(event.children["Tree Versions"])
      ? event.children["Tree Versions"].map(String)
      : [];
    const affected = graph.entries.filter(
      (entry) =>
        packageNameFromLocator(entry.resolution) === name &&
        versions.includes(entry.version),
    );
    if (!affected.length) {
      findings.push(
        `unmapped advisory locator: ${name} ${versions.join(",") || "<missing version>"}`,
      );
      continue;
    }
    const locatorResults = affected.map((entry) => {
      const categories = [
        ...(locatorCategories.get(entry.resolution) ?? new Set()),
      ].sort();
      return {
        resolution: entry.resolution,
        categories: categories.length ? categories : ["outside-electron"],
      };
    });
    const inScope = locatorResults.flatMap((value) =>
      value.categories.filter((category) => category !== "outside-electron"),
    );
    const advisory = {
      id: event.children.ID ?? null,
      issue: event.children.Issue,
      name,
      severity: event.children.Severity.toLowerCase(),
      locators: locatorResults,
    };
    advisories.push(advisory);
    if (["high", "critical"].includes(advisory.severity) && inScope.length) {
      findings.push(
        `${advisory.severity} advisory ${advisory.id ?? advisory.issue} reaches ${[...new Set(inScope)].sort().join(", ")} through ${name}`,
      );
    }
  }
  return { advisories, findings };
}

function compareVersion(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((leftParts[index] ?? 0) !== (rightParts[index] ?? 0)) {
      return (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    }
  }
  return 0;
}

function verifyManifestDependencies(path, manifest, occurrences) {
  const findings = [];
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest[section] ?? {};
    for (const [name, actual] of Object.entries(dependencies)) {
      const location = `${path}#${section}.${name}`;
      if (prohibitedDirectDependencies.has(name)) {
        findings.push(`${location} is a prohibited direct dependency`);
      }
      if (
        name === "typescript" &&
        (actual.startsWith("npm:") || actual.startsWith("patch:"))
      ) {
        findings.push(`${location} must use the normal TypeScript owner`);
      }
      const target = exactVersions.get(name);
      if (target === undefined) continue;
      occurrences?.[name]?.push({ actual, location });
      if (actual !== target) {
        findings.push(`${location} must be exactly ${target}, found ${actual}`);
      }
    }
  }
  for (const prohibited of findProhibitedKeys(manifest)) {
    findings.push(`${path} contains prohibited advisory bypass ${prohibited}`);
  }
  return findings;
}

function verifyManifests() {
  const occurrences = Object.fromEntries(
    [...exactVersions].map(([name]) => [name, []]),
  );
  const findings = [];
  for (const path of walkFiles(".", (path) => path.endsWith("package.json"))) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    findings.push(
      ...verifyManifestDependencies(
        relative(repoRoot, path),
        manifest,
        occurrences,
      ),
    );
  }
  for (const [name, values] of Object.entries(occurrences)) {
    if (!values.length) findings.push(`required dependency ${name} is absent`);
  }
  const electronManifest = readJson("client/apps/electron/package.json");
  const electronNanoid =
    electronManifest.dependencies?.nanoid ??
    electronManifest.devDependencies?.nanoid ??
    null;
  if (electronNanoid !== "6.0.1") {
    findings.push(
      `client/apps/electron/package.json must own nanoid exactly at 6.0.1, found ${electronNanoid ?? "<missing>"}`,
    );
  }
  return { findings, occurrences };
}

function verifyToolchainLock(graph) {
  const allowed = new Map([
    ["@vitest/browser", "4.1.11"],
    ["@vitest/browser-playwright", "4.1.11"],
    ["@vitest/coverage-istanbul", "4.1.11"],
    ["@vitest/ui", "4.1.11"],
    ["typescript", "7.0.2"],
    ["vite", "8.3.1"],
    ["vitest", "4.1.11"],
  ]);
  const findings = [];
  for (const entry of graph.entries) {
    const name = packageNameFromLocator(entry.resolution);
    if (prohibitedDirectDependencies.has(name) && name !== "@vitest/browser") {
      findings.push(
        `prohibited TypeScript owner resolved: ${entry.resolution}`,
      );
      continue;
    }
    const expected = allowed.get(name);
    if (expected !== undefined && entry.version !== expected) {
      findings.push(
        `${entry.resolution} must resolve ${name} exactly to ${expected}`,
      );
    }
  }
  return findings;
}

function verifyExactLockVersions(graph) {
  const findings = [];
  for (const [name, expected] of exactVersions) {
    const matching = graph.entries.filter(
      (entry) => packageNameFromLocator(entry.resolution) === name,
    );
    if (!matching.length) {
      findings.push(`${name}@${expected} is absent from yarn.lock`);
      continue;
    }
    for (const entry of matching) {
      if (entry.version !== expected) {
        findings.push(
          `${entry.resolution} must resolve ${name} exactly to ${expected}`,
        );
      }
    }
  }
  const nanoid6 = graph.entries.filter(
    (entry) =>
      packageNameFromLocator(entry.resolution) === "nanoid" &&
      entry.version.startsWith("6."),
  );
  if (!nanoid6.length) {
    findings.push("nanoid@6.0.1 is absent from yarn.lock");
  }
  for (const entry of nanoid6) {
    if (entry.version !== "6.0.1") {
      findings.push(
        `${entry.resolution} must resolve Nanoid 6 exactly to 6.0.1`,
      );
    }
  }
  return findings;
}

function findElectron44RemovedMainApis(sources) {
  return sources.flatMap(({ path, source }) =>
    electron44RemovedMainApiPatterns.flatMap(([label, pattern]) =>
      pattern.test(source) ? [`${path} still calls Electron 44 ${label}`] : [],
    ),
  );
}

function verifyElectron44MigrationContract() {
  return findElectron44RemovedMainApis(
    walkFiles("client/apps/electron/src/main", (path) =>
      sourceExtensions.has(extname(path)),
    ).map((path) => ({
      path: relative(repoRoot, path),
      source: readFileSync(path, "utf8"),
    })),
  );
}

function verifyRootResolutions() {
  const manifest = readJson("package.json");
  const ownedPackageNames = new Set(
    [...exactRootResolutions].map(([descriptor]) =>
      packageNameFromLocator(descriptor),
    ),
  );
  const ownedDescriptors = Object.keys(manifest.resolutions ?? {}).filter(
    (descriptor) =>
      [...ownedPackageNames].some((name) => descriptor.startsWith(`${name}@`)),
  );
  const actual = Object.fromEntries(
    [...exactRootResolutions].map(([descriptor]) => [
      descriptor,
      manifest.resolutions?.[descriptor] ?? null,
    ]),
  );
  const findings = [...exactRootResolutions].flatMap(
    ([descriptor, expected]) =>
      actual[descriptor] === expected
        ? []
        : [
            `package.json#resolutions.${descriptor} must be exactly ${expected}, found ${actual[descriptor] ?? "<missing>"}`,
          ],
  );
  const unexpectedDescriptors = ownedDescriptors.filter(
    (descriptor) => !exactRootResolutions.has(descriptor),
  );
  if (unexpectedDescriptors.length) {
    findings.push(
      `package.json contains broadened Electron release-build resolutions: ${unexpectedDescriptors.join(", ")}`,
    );
  }
  return { actual, findings, ownedDescriptors };
}

function verifyRenovateContract() {
  const findings = [];
  const config = readJson("renovate.json");
  const packageRules = config.packageRules ?? [];
  const workflowPath = ".forgejo/workflows/renovate.yml";
  const workflow = readFileSync(join(repoRoot, workflowPath), "utf8");
  if (config.ignorePaths?.includes("packages/**")) {
    findings.push("renovate.json still ignores the removed packages/** tree");
  }
  if (config.ignorePaths?.some((path) => path.startsWith("virgultum"))) {
    findings.push("renovate.json must discover active Virgultum dependencies");
  }
  const alerts = config.vulnerabilityAlerts ?? {};
  if (config.osvVulnerabilityAlerts !== true) {
    findings.push("Forgejo Renovate requires OSV vulnerability discovery");
  }
  if (!config.schedule?.includes("before 6am")) {
    findings.push("Renovate must discover normal dependency updates daily");
  }
  if (
    alerts.enabled !== true ||
    !alerts.labels?.includes("security") ||
    !alerts.schedule?.includes("at any time")
  ) {
    findings.push(
      "Renovate vulnerability alerts are not immediate labelled security updates",
    );
  }
  if (!config.baseBranchPatterns?.includes("wip")) {
    findings.push("Renovate does not target the wip base branch");
  }
  const electronPackages = ["electron", "electron-*", "@electron/*"];
  const ownsElectronFamily = (rule) =>
    electronPackages.every((name) => rule.matchPackageNames?.includes(name));
  const electronDaily = packageRules.find(
    (rule) =>
      ownsElectronFamily(rule) &&
      ["patch", "minor"].every((type) =>
        rule.matchUpdateTypes?.includes(type),
      ) &&
      rule.schedule?.includes("before 6am") &&
      rule.automerge === false,
  );
  if (!electronDaily) {
    findings.push(
      "Renovate must review Electron patch and minor updates daily without automerge",
    );
  }
  const electronMajor = packageRules.find(
    (rule) =>
      ownsElectronFamily(rule) &&
      rule.matchUpdateTypes?.includes("major") &&
      rule.schedule?.includes("before 6am on the first day of the month") &&
      rule.automerge === false,
  );
  if (!electronMajor) {
    findings.push(
      "Renovate must discover Electron majors in the monthly migration batch",
    );
  }
  const virgultumReview = packageRules.find(
    (rule) =>
      rule.matchFileNames?.includes("virgultum/**/package.json") &&
      rule.labels?.includes("editor-review") &&
      rule.automerge === false,
  );
  if (!virgultumReview) {
    findings.push(
      "Renovate must discover Virgultum manifests for explicit editor review",
    );
  }
  for (const required of [
    "workflow_dispatch:",
    "schedule:",
    "secrets.RENOVATE_TOKEN",
    'test -n "$RENOVATE_TOKEN"',
    "RENOVATE_PLATFORM=forgejo",
    "RENOVATE_REPOSITORIES=myoxus/myoxus",
    "RENOVATE_CONFIG_VALIDATION_ERROR=true",
    "docker.io/renovate/renovate:43.278.3@sha256:7ceed8dcc6321f2c1e4a0740f077e44868b3c50eee50720f685284e709f61033",
  ]) {
    if (!workflow.includes(required)) {
      findings.push(`${workflowPath} is missing required contract ${required}`);
    }
  }
  for (const forbidden of [
    "MYOXUS_RELEASE_TOKEN",
    "MYOXUS_REGISTRY_PASSWORD",
    "MYOXUS_REGISTRY_USER",
  ]) {
    if (workflow.includes(forbidden)) {
      findings.push(
        `${workflowPath} must not consume publishing secret ${forbidden}`,
      );
    }
  }
  return findings;
}

function runAudit() {
  const result = spawnSync(
    "yarn",
    ["npm", "audit", "--recursive", "--all", "--severity", "high", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    },
  );
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status)) {
    throw new Error(
      `yarn npm audit failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function expectFixtureFailure(label, fixture, pattern) {
  const result = classifyAudit(
    [fixture.event],
    { entries: [fixture.entry] },
    new Map([[fixture.entry.resolution, new Set(fixture.categories)]]),
  );
  if (!result.findings.some((finding) => pattern.test(finding))) {
    throw new Error(`${label} negative fixture did not fail causally`);
  }
  return label;
}

function expectManifestFixtureFailure(label, devDependencies, pattern) {
  const findings = verifyManifestDependencies(`fixture/${label}/package.json`, {
    devDependencies,
  });
  if (!findings.some((finding) => pattern.test(finding))) {
    throw new Error(
      `${label} manifest fixture did not fail causally: ${findings.join("; ")}`,
    );
  }
  return label;
}

function runSelfTests() {
  const fixture = (category) => ({
    event: {
      value: "fixture-package",
      children: {
        ID: `fixture-${category}`,
        Issue: "Synthetic high advisory",
        Severity: "high",
        "Tree Versions": ["1.0.0"],
      },
    },
    entry: {
      resolution: "fixture-package@npm:1.0.0",
      version: "1.0.0",
    },
    categories: [category],
  });
  const passed = [
    expectFixtureFailure("runtime-high", fixture("runtime"), /reaches runtime/),
    expectFixtureFailure(
      "release-build-high",
      fixture("release-build"),
      /reaches release-build/,
    ),
    expectFixtureFailure(
      "mandatory-test-high",
      fixture("mandatory-test"),
      /reaches mandatory-test/,
    ),
  ];
  const unmapped = classifyAudit(
    [fixture("runtime").event],
    { entries: [] },
    new Map(),
  );
  if (
    !unmapped.findings.some((finding) =>
      /unmapped advisory locator/.test(finding),
    )
  ) {
    throw new Error("unmapped-locator negative fixture did not fail causally");
  }
  passed.push("unmapped-locator");
  if (!findProhibitedKeys({ auditAllowlist: ["fixture"] }).length) {
    throw new Error(
      "prohibited-allowlist negative fixture did not fail causally",
    );
  }
  passed.push("prohibited-allowlist");
  passed.push(
    expectManifestFixtureFailure(
      "vite-7",
      { vite: "7.3.6" },
      /vite.*must be exactly 8\.3\.1/,
    ),
    expectManifestFixtureFailure(
      "vitest-3",
      { vitest: "3.2.7" },
      /vitest.*must be exactly 4\.1\.11/,
    ),
    expectManifestFixtureFailure(
      "retired-vitest-browser",
      { "@vitest/browser": "3.2.7" },
      /prohibited direct dependency/,
    ),
    expectManifestFixtureFailure(
      "mismatched-vitest-family",
      { "@vitest/ui": "4.1.9" },
      /@vitest\/ui.*must be exactly 4\.1\.11/,
    ),
    expectManifestFixtureFailure(
      "typescript-alias",
      { typescript: "npm:@typescript/native-preview@7.0.0" },
      /normal TypeScript owner/,
    ),
    expectManifestFixtureFailure(
      "second-typescript-owner",
      { "@typescript/native-preview": "7.0.0" },
      /prohibited direct dependency/,
    ),
  );
  const removedApiFindings = findElectron44RemovedMainApis([
    {
      path: "fixture/removed-electron-44-api.ts",
      source: "clipboard.writeImage(image);",
    },
  ]);
  if (
    !removedApiFindings.some((finding) =>
      finding.includes("removed clipboard helper"),
    )
  ) {
    throw new Error("removed-electron-44-api negative fixture did not fail");
  }
  passed.push("removed-electron-44-api");
  return passed;
}

const selfTests = runSelfTests();
if (process.argv.includes("--self-test")) {
  const renovateFindings = verifyRenovateContract();
  if (renovateFindings.length) throw new Error(renovateFindings.join("\n"));
  console.log(`Electron dependency policy self-tests: ${selfTests.join(", ")}`);
  process.exit(0);
}

const rootManifest = readJson("package.json");
const electronManifest = readJson("client/apps/electron/package.json");
const ranges = {
  ...rootManifest.dependencies,
  ...rootManifest.devDependencies,
  ...electronManifest.dependencies,
  ...electronManifest.devDependencies,
};
const graph = lockGraph();
const workspaces = workspacePackages();
// These packages are invoked as manifest binaries rather than imported by a
// source module. They are nevertheless executable parts of every package/make
// run and must remain inside the release-build advisory closure.
const releaseCommandRoots = ["@electron/packager", "cross-env"];
const groups = {
  runtime: importsFor(walkFiles("client/apps/electron/src")),
  "release-build": [
    ...new Set([
      ...importsFor([...walkFiles("client/apps/electron/scripts")]),
      ...releaseCommandRoots,
    ]),
  ].sort(),
  "mandatory-test": importsFor([
    ...walkFiles("client/apps/electron/test"),
    join(repoRoot, "client/apps/electron/vitest.config.mts"),
  ]),
};
const closure = Object.fromEntries(
  Object.entries(groups).map(([category, imports]) => [
    category,
    resolveClosure(
      imports,
      ranges,
      graph,
      rootManifest.resolutions,
      workspaces,
      category,
    ),
  ]),
);
const locatorCategories = new Map();
for (const [category, value] of Object.entries(closure)) {
  for (const locator of value.locators) {
    const categories = locatorCategories.get(locator.resolution) ?? new Set();
    categories.add(category);
    locatorCategories.set(locator.resolution, categories);
  }
}

const auditFileIndex = process.argv.indexOf("--audit-file");
const auditText =
  auditFileIndex >= 0
    ? readFileSync(resolve(process.argv[auditFileIndex + 1]), "utf8")
    : runAudit();
const parsedAudit = auditEvents(auditText);
const manifestResult = verifyManifests();
const resolutionResult = verifyRootResolutions();
const auditResult = classifyAudit(parsedAudit.events, graph, locatorCategories);
const formDataFindings = [...locatorCategories]
  .filter(([resolution]) => resolution.startsWith("form-data@npm:"))
  .filter(
    ([resolution]) =>
      compareVersion(resolution.slice("form-data@npm:".length), "4.0.6") < 0,
  )
  .map(
    ([resolution, categories]) =>
      `${resolution} is below 4.0.6 in ${[...categories].sort().join(", ")}`,
  );
const findings = [
  ...manifestResult.findings,
  ...resolutionResult.findings,
  ...verifyRenovateContract(),
  ...Object.values(closure).flatMap((value) =>
    value.unmapped.map(
      (entry) =>
        `unmapped ${entry.category} import ${entry.name}@${entry.range ?? "<missing>"}`,
    ),
  ),
  ...parsedAudit.invalid.map((line) => `invalid audit JSON at line ${line}`),
  ...auditResult.findings,
  ...verifyToolchainLock(graph),
  ...verifyExactLockVersions(graph),
  ...verifyElectron44MigrationContract(),
  ...formDataFindings,
  ...(graph.entries.some(
    (entry) => entry.resolution === "@electron/universal@npm:2.0.3",
  )
    ? ["stale @electron/universal@npm:2.0.3 locator remains in yarn.lock"]
    : []),
];
const report = {
  schema: "myoxus-electron-dependency-policy-v1",
  exactVersions: Object.fromEntries(exactVersions),
  exactRootResolutions: Object.fromEntries(exactRootResolutions),
  ownedRootResolutionDescriptors: resolutionResult.ownedDescriptors,
  rootResolutionState: resolutionResult.actual,
  manifestOccurrences: manifestResult.occurrences,
  closure,
  advisories: auditResult.advisories,
  selfTests,
  findings,
};
mkdirSync(outputRoot, { recursive: true });
const reportPathIndex = process.argv.indexOf("--report");
const reportPath =
  reportPathIndex >= 0
    ? resolve(process.argv[reportPathIndex + 1])
    : join(outputRoot, "dependency-policy.json");
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, stableJson(report));

for (const advisory of report.advisories) {
  const categories = [
    ...new Set(advisory.locators.flatMap((locator) => locator.categories)),
  ].sort();
  console.log(
    `${advisory.severity} ${advisory.name} (${advisory.id ?? "no-id"}): ${categories.join(", ")}`,
  );
}
if (findings.length) {
  for (const finding of findings) console.error(`electron-policy: ${finding}`);
  process.exit(1);
}
console.log(
  `Electron dependency policy passed (${auditResult.advisories.length} mapped advisories; all High/Critical Electron closures clean)`,
);
