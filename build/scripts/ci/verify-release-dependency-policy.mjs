// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectModuleReferences } from "./source-imports.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(repoRoot, "package.json"));
const { parse: parseYaml } = require("yaml");
const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const artifactExtensions = new Set([".cjs", ".html", ".js", ".json", ".mjs"]);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const ignoredDirectories = new Set([
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
const prohibitedPolicyKeys = new Set([
  "advisoryAllowlist",
  "auditAllowlist",
  "auditExceptions",
  "auditIgnoreAdvisories",
  "ignoredAdvisories",
]);
const exactDependencyVersions = new Map([
  ["@graphql-codegen/core", "6.2.2"],
  ["@sentry/electron", "7.20.0"],
  ["@sentry/react", "10.75.0"],
  ["dompurify", "3.4.17"],
  ["file-type", "22.1.1"],
  ["happy-dom", "21.0.4"],
  ["http-proxy-middleware", "3.0.7"],
  ["katex", "0.18.2"],
  ["mermaid", "11.17.2"],
  ["path-to-regexp", "8.4.2"],
  ["react-router", "7.18.4"],
  ["uuid", "13.0.1"],
  ["yaml", "2.9.1"],
]);
const exactResolvedVersions = new Map([
  ["@sentry/bundler-plugins", "10.75.0"],
  ["@sentry/core", "10.75.0"],
  ["@sentry/electron", "7.20.0"],
  ["@sentry/react", "10.75.0"],
  ["dompurify", "3.4.17"],
  ["katex", "0.18.2"],
  ["mermaid", "11.17.2"],
  ["react-router", "7.18.4"],
]);
const resolvedVersionPolicies = [
  ["@graphql-tools/utils", 12, "12.0.3"],
  ["source-map-js", 1, "1.2.2"],
  ["@ardatan/relay-compiler", 13, "13.0.2"],
  ["@ungap/structured-clone", 1, "1.3.3"],
  ["body-parser", 2, "2.3.0"],
  ["brace-expansion", 1, "1.1.17"],
  ["brace-expansion", 2, "2.1.3"],
  ["brace-expansion", 5, "5.0.12"],
  ["flatted", 3, "3.4.4"],
  ["follow-redirects", 1, "1.16.0"],
  ["immutable", 5, "5.1.8"],
  ["path-to-regexp", 8, "8.4.2"],
  ["qs", 6, "6.15.3"],
  ["shell-quote", 1, "1.10.0"],
  ["svgo", 3, "3.3.5"],
  ["yaml", 2, "2.9.1"],
];
const artifactRoots = [
  ["browser-runtime", "client/web/workspaces/web/dist"],
  ["admin-runtime", "client/admin/workspaces/admin/dist"],
  ["electron-renderer", "client/apps/electron-renderer/dist"],
];
const rscArtifactMarkers = [
  "@react-router/dev",
  "@react-router/node",
  "react-router/server",
  "react-server",
  "routeRSCServerRequest",
  "RSCStaticRouter",
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

function walkFiles(root, predicate = () => true, ignored = ignoredDirectories) {
  const files = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  }
  visit(resolve(repoRoot, root));
  return files.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
}

function packageNameFromLocator(locator) {
  return locator.match(/^(@[^/]+\/[^@]+|[^@]+)@/)?.[1] ?? null;
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

function sourceImports(files) {
  const imports = new Set();
  const specifiers = [];
  for (const path of files) {
    if (!sourceExtensions.has(extname(path))) continue;
    const source = readFileSync(path, "utf8");
    for (const reference of collectModuleReferences(path, source)) {
      const { importedNames, kind, line, specifier } = reference;
      const name = moduleName(specifier);
      if (name) imports.add(name);
      specifiers.push({
        kind,
        line,
        path: relative(repoRoot, path),
        specifier,
        importedNames,
      });
    }
  }
  return { imports: [...imports].sort(), specifiers };
}

function lockGraph() {
  const lock = parseYaml(readFileSync(join(repoRoot, "yarn.lock"), "utf8"));
  const descriptorIndex = new Map();
  const entries = [];
  for (const [descriptors, value] of Object.entries(lock)) {
    if (descriptors === "__metadata") continue;
    const entry = {
      dependencies: value.dependencies ?? {},
      descriptors: descriptors.split(", ").sort(),
      resolution: value.resolution,
      version: String(value.version),
    };
    entries.push(entry);
    for (const descriptor of entry.descriptors)
      descriptorIndex.set(descriptor, entry);
  }
  return { descriptorIndex, entries };
}

function descriptorFor(name, range, graph, resolutions) {
  const normalized = range?.startsWith("npm:") ? range.slice(4) : range;
  const override =
    resolutions?.[`${name}@${range}`] ??
    resolutions?.[`${name}@npm:${normalized}`] ??
    resolutions?.[name];
  for (const requested of [override, range].filter(Boolean)) {
    for (const descriptor of [
      `${name}@${requested}`,
      ...(requested.includes(":") ? [] : [`${name}@npm:${requested}`]),
    ]) {
      const exact = graph.descriptorIndex.get(descriptor);
      if (exact) return exact;
    }
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
    const sourceRoot = join(dirname(manifestPath), "src");
    const files = walkFiles(relative(repoRoot, sourceRoot)).filter((path) => {
      const rel = relative(repoRoot, path);
      return (
        !/[.](?:bench|spec|test)[.][cm]?[jt]sx?$/.test(rel) &&
        !rel
          .split(/[\\/]/)
          .some((segment) =>
            ["__tests__", "fixtures", "test-utils"].includes(segment),
          )
      );
    });
    packages.set(manifest.name, {
      imports: sourceImports(files).imports,
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
    parent: `<${category}>`,
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
      unmapped.set(
        `${current.parent}:${current.name}:${current.range}`,
        current,
      );
      continue;
    }
    if (locators.has(entry.resolution)) continue;
    locators.set(entry.resolution, {
      parent: current.parent,
      resolution: entry.resolution,
      version: entry.version,
    });
    if (entry.resolution.includes("@workspace:")) {
      const workspace = workspaces.get(current.name);
      if (!workspace) {
        unmapped.set(`workspace:${current.name}`, current);
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
    unmapped: [...unmapped.values()],
  };
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

function isRscOnlyAdvisory(event) {
  const issue = event.children.Issue.toLowerCase();
  return event.value === "react-router" && issue.includes("rsc mode");
}

function classifyAudit(events, graph, locatorCategories, modeEvidence) {
  const advisories = [];
  const findings = [];
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
    const locators = affected.map((entry) => {
      const categories = [
        ...(locatorCategories.get(entry.resolution) ?? new Set()),
      ].sort();
      return {
        categories: categories.length ? categories : ["outside-release"],
        resolution: entry.resolution,
      };
    });
    const releaseCategories = [
      ...new Set(locators.flatMap((locator) => locator.categories)),
    ]
      .filter((category) => category !== "outside-release")
      .sort();
    const severity = event.children.Severity.toLowerCase();
    const inactivePackageMode =
      ["high", "critical"].includes(severity) &&
      releaseCategories.length > 0 &&
      isRscOnlyAdvisory(event) &&
      modeEvidence.clean;
    advisories.push({
      id: event.children.ID ?? null,
      inactivePackageMode,
      issue: event.children.Issue,
      locators,
      name,
      severity,
    });
    if (
      ["high", "critical"].includes(severity) &&
      releaseCategories.length > 0 &&
      !inactivePackageMode
    ) {
      findings.push(
        `${severity} advisory ${event.children.ID ?? event.children.Issue} reaches ${releaseCategories.join(", ")} through ${name}`,
      );
    }
  }
  return { advisories, findings };
}

function findProhibitedKeys(value, path = "$") {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(prohibitedPolicyKeys.has(key) ? [`${path}.${key}`] : []),
    ...findProhibitedKeys(entry, `${path}.${key}`),
  ]);
}

function compareVersion(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function matchesExactVersion(name, expected, actual, graph) {
  if (actual === expected) return true;
  const patch = /^patch:([^#]+)#(.+)$/.exec(actual);
  if (!patch) return false;
  // A Yarn patch preserves the pinned upstream version only when both its
  // source descriptor and the corresponding lock entry retain that exact pin.
  try {
    if (decodeURIComponent(patch[1]) !== `${name}@npm:${expected}`)
      return false;
  } catch {
    return false;
  }
  const entry = graph.descriptorIndex.get(`${name}@${actual}`);
  return (
    entry?.version === expected &&
    packageNameFromLocator(entry.resolution) === name
  );
}

function verifyVersionContract(graph) {
  const occurrences = Object.fromEntries(
    [...exactDependencyVersions].map(([name]) => [name, []]),
  );
  const findings = [];
  for (const path of walkFiles(".", (file) => file.endsWith("package.json"))) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, expected] of exactDependencyVersions) {
        const actual = manifest[section]?.[name];
        if (actual === undefined) continue;
        const location = `${relative(repoRoot, path)}#${section}.${name}`;
        occurrences[name].push({ actual, location });
        if (
          !matchesExactVersion(name, expected, actual, graph) &&
          !(section === "peerDependencies" && actual === "*")
        ) {
          findings.push(
            `${location} must be exactly ${expected}, found ${actual}`,
          );
        }
      }
    }
    for (const prohibited of findProhibitedKeys(manifest)) {
      findings.push(
        `${relative(repoRoot, path)} contains prohibited advisory bypass ${prohibited}`,
      );
    }
  }
  for (const [name, major, minimum] of resolvedVersionPolicies) {
    const matching = graph.entries.filter((entry) => {
      const resolvedMajor = Number(entry.version.split(".", 1)[0]);
      return (
        packageNameFromLocator(entry.resolution) === name &&
        resolvedMajor === major
      );
    });
    if (!matching.length) {
      // Transitive security lines constrain versions only while that major is
      // present. Requiring an unused major would reintroduce obsolete packages
      // solely to satisfy the verifier and would enlarge the release closure.
      continue;
    }
    for (const entry of matching) {
      if (compareVersion(entry.version, minimum) < 0) {
        findings.push(
          `${entry.resolution} is below the ${minimum} security line`,
        );
      }
    }
  }
  for (const [name, expected] of exactResolvedVersions) {
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
  for (const entry of graph.entries) {
    const name = packageNameFromLocator(entry.resolution);
    // GHSA-hp3w-g68c-fv3c has no patched sprintf-js release. Keep the
    // vulnerable package absent, including when a new parent reintroduces it.
    if (name === "sprintf-js") {
      findings.push(`${entry.resolution} reintroduces unpatched sprintf-js`);
    }
    if (
      [
        "@opentelemetry/core",
        "@opentelemetry/resources",
        "@opentelemetry/sdk-trace",
      ].includes(name) &&
      compareVersion(entry.version, "2.10.0") < 0
    ) {
      findings.push(
        `${entry.resolution} is below the OpenTelemetry 2.10.0 security line`,
      );
    }
  }
  return { findings, occurrences };
}

function sourceModeEvidence(extraSpecifiers = []) {
  const roots = ["client", "tools/cli/src", "tools/utils/src", "virgultum"];
  const files = roots.flatMap((root) => walkFiles(root));
  const scanned = sourceImports(files);
  const specifiers = [...scanned.specifiers, ...extraSpecifiers];
  const forbidden = specifiers.filter(
    ({ importedNames, specifier }) =>
      /^(?:react-router(?:-dom)?\/(?:server|rsc)|@react-router\/(?:cloudflare|dev|express|node))(?:\/|$)/.test(
        specifier,
      ) ||
      (/^react-router(?:-dom)?$/.test(specifier) &&
        importedNames.some((name) => /^unstable_.*RSC.*$/.test(name))),
  );
  const configFindings = walkFiles(".", (path) =>
    /(?:rspack|vite|webpack)[.]config[.][cm]?[jt]s$/.test(path),
  ).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return text.includes("react-server")
      ? [`${relative(repoRoot, path)} activates the react-server condition`]
      : [];
  });
  return {
    clean: forbidden.length === 0 && configFindings.length === 0,
    configFindings,
    forbiddenImports: forbidden,
    scannedFileCount: files.length,
  };
}

function artifactModeEvidence(roots = artifactRoots) {
  const findings = [];
  const artifacts = [];
  const sourceMtime = Math.max(
    statSync(join(repoRoot, "yarn.lock")).mtimeMs,
    ...[
      "client/web/workspaces/web/src",
      "client/admin/workspaces/admin/src",
      "client/apps/electron-renderer/src",
    ]
      .flatMap((root) => walkFiles(root))
      .map((path) => statSync(path).mtimeMs),
  );
  for (const [category, root] of roots) {
    const absolute = resolve(repoRoot, root);
    if (!existsSync(absolute)) {
      findings.push(`${category} artifact root is missing: ${root}`);
      continue;
    }
    const files = walkFiles(
      root,
      (path) => artifactExtensions.has(extname(path)),
      new Set(),
    );
    if (!files.length) {
      findings.push(
        `${category} artifact root contains no inspectable bundle files: ${root}`,
      );
      continue;
    }
    const newest = Math.max(...files.map((path) => statSync(path).mtimeMs));
    if (newest < sourceMtime) {
      findings.push(
        `${category} artifacts predate the dependency/source inputs: ${root}`,
      );
    }
    const hash = createHash("sha256");
    const markers = [];
    for (const path of files) {
      const content = readFileSync(path);
      hash.update(relative(absolute, path));
      hash.update(content);
      const text = content.toString("utf8");
      for (const marker of rscArtifactMarkers) {
        if (text.includes(marker))
          markers.push({ marker, path: relative(repoRoot, path) });
      }
    }
    findings.push(
      ...markers.map(
        ({ marker, path }) =>
          `${category} artifact ${path} contains RSC marker ${marker}`,
      ),
    );
    artifacts.push({
      category,
      digest: hash.digest("hex"),
      fileCount: files.length,
      root,
    });
  }
  return { artifacts, clean: findings.length === 0, findings };
}

function runSelfTests() {
  const patch = "patch:fixture-package@npm%3A1.2.3#./fixture.patch";
  const patchEntry = {
    resolution: `fixture-package@${patch}::version=1.2.3&hash=fixture`,
    version: "1.2.3",
  };
  const patchGraph = {
    descriptorIndex: new Map([[`fixture-package@${patch}`, patchEntry]]),
  };
  if (!matchesExactVersion("fixture-package", "1.2.3", patch, patchGraph)) {
    throw new Error("locked patch of the exact upstream pin was rejected");
  }
  const invalidDescriptors = [
    patch.replace("1.2.3", "1.2.4"),
    patch.replace("1.2.3", "^1.2.3"),
    patch.replace("fixture-package", "other-package"),
    patch.replace("%3A", "%XX"),
    "^1.2.3",
  ];
  for (const [actual, graph] of [
    ...invalidDescriptors.map((actual) => [
      actual,
      { descriptorIndex: new Map([[`fixture-package@${actual}`, patchEntry]]) },
    ]),
    [patch, { descriptorIndex: new Map() }],
    [
      patch,
      {
        descriptorIndex: new Map([
          [`fixture-package@${patch}`, { ...patchEntry, version: "1.2.4" }],
        ]),
      },
    ],
    [
      patch,
      {
        descriptorIndex: new Map([
          [
            `fixture-package@${patch}`,
            { ...patchEntry, resolution: "other-package@npm:1.2.3" },
          ],
        ]),
      },
    ],
  ]) {
    if (matchesExactVersion("fixture-package", "1.2.3", actual, graph)) {
      throw new Error("unpinned or mismatched patch fixture was accepted");
    }
  }
  const categories = [
    "browser-runtime",
    "admin-runtime",
    "release-build",
    "mandatory-test",
  ];
  const passed = ["exact-patched-version", "unpinned-patch-rejected"];
  for (const category of categories) {
    const event = {
      value: "fixture-package",
      children: {
        ID: `fixture-${category}`,
        Issue: "Synthetic high advisory",
        Severity: "high",
        "Tree Versions": ["1.0.0"],
      },
    };
    const entry = { resolution: "fixture-package@npm:1.0.0", version: "1.0.0" };
    const result = classifyAudit(
      [event],
      { entries: [entry] },
      new Map([[entry.resolution, new Set([category])]]),
      { clean: true },
    );
    if (
      !result.findings.some((finding) =>
        finding.includes(`reaches ${category}`),
      )
    ) {
      throw new Error(`${category} negative fixture did not fail causally`);
    }
    passed.push(`${category}-high`);
  }
  const unmapped = classifyAudit(
    [
      {
        value: "fixture-package",
        children: {
          Issue: "Synthetic high advisory",
          Severity: "high",
          "Tree Versions": ["1.0.0"],
        },
      },
    ],
    { entries: [] },
    new Map(),
    { clean: true },
  );
  if (
    !unmapped.findings.some((finding) =>
      finding.startsWith("unmapped advisory locator"),
    )
  ) {
    throw new Error("unmapped-locator negative fixture did not fail causally");
  }
  passed.push("unmapped-locator");
  const rscEvent = {
    value: "react-router",
    children: {
      Issue: "React Router: RSC Mode synthetic advisory",
      Severity: "high",
      "Tree Versions": ["7.18.4"],
    },
  };
  const rscEntry = { resolution: "react-router@npm:7.18.4", version: "7.18.4" };
  const rscCategories = new Map([
    [rscEntry.resolution, new Set(["browser-runtime"])],
  ]);
  if (
    classifyAudit([rscEvent], { entries: [rscEntry] }, rscCategories, {
      clean: true,
    }).findings.length
  ) {
    throw new Error("clean inactive RSC mode fixture was not accepted");
  }
  const activeRsc = classifyAudit(
    [rscEvent],
    { entries: [rscEntry] },
    rscCategories,
    { clean: false },
  );
  if (
    !activeRsc.findings.some((finding) =>
      finding.includes("reaches browser-runtime"),
    )
  ) {
    throw new Error("active RSC mode negative fixture did not fail causally");
  }
  const sourceActivation = sourceModeEvidence([
    {
      importedNames: ["unstable_routeRSCServerRequest"],
      kind: "import",
      line: 1,
      path: "fixture.ts",
      specifier: "react-router",
    },
  ]);
  if (
    sourceActivation.clean ||
    sourceActivation.forbiddenImports.length !== 1
  ) {
    throw new Error("RSC source-import negative fixture did not fail causally");
  }
  passed.push("inactive-rsc-mode", "active-rsc-mode", "rsc-source-import");
  if (!findProhibitedKeys({ auditAllowlist: ["fixture"] }).length) {
    throw new Error(
      "prohibited-allowlist negative fixture did not fail causally",
    );
  }
  passed.push("prohibited-allowlist");
  return passed;
}

const selfTests = runSelfTests();
if (process.argv.includes("--self-test")) {
  console.log(`Release dependency policy self-tests: ${selfTests.join(", ")}`);
  process.exit(0);
}

const rootManifest = readJson("package.json");
const graph = lockGraph();
const workspaces = workspacePackages();
const rootRanges = {
  ...rootManifest.dependencies,
  ...rootManifest.devDependencies,
};
const packageRanges = (name) => workspaces.get(name)?.ranges ?? {};
const groups = {
  "browser-runtime": {
    imports: ["@myoxus/web"],
    ranges: { ...rootRanges, "@myoxus/web": "workspace:*" },
  },
  "admin-runtime": {
    imports: ["@myoxus/admin"],
    ranges: { ...rootRanges, "@myoxus/admin": "workspace:*" },
  },
  "release-build": {
    imports: [
      "@graphql-codegen/core",
      "@graphql-codegen/plugin-helpers",
      "@graphql-codegen/typescript",
      "@graphql-codegen/typescript-operations",
      "@myoxus-tools/cli",
      "@myoxus-tools/utils",
    ],
    ranges: {
      ...rootRanges,
      ...packageRanges("@myoxus/graphql"),
      "@myoxus-tools/cli": "workspace:*",
      "@myoxus-tools/utils": "workspace:*",
    },
  },
  "mandatory-test": {
    imports: [
      "@myoxus-test/kit",
      "@vitest/browser",
      "@vitest/coverage-istanbul",
      "@vitest/ui",
      "vitest",
    ].sort(),
    ranges: {
      ...rootRanges,
      "@myoxus-test/kit": "workspace:*",
    },
  },
};
const closure = Object.fromEntries(
  Object.entries(groups).map(([category, group]) => [
    category,
    resolveClosure(
      group.imports,
      group.ranges,
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
const sourceEvidence = sourceModeEvidence();
const artifactEvidence = artifactModeEvidence();
const modeEvidence = {
  clean: sourceEvidence.clean && artifactEvidence.clean,
  source: sourceEvidence,
  artifacts: artifactEvidence,
};
const auditIndex = process.argv.indexOf("--audit-file");
if (auditIndex < 0 || !process.argv[auditIndex + 1]) {
  throw new Error(
    "--audit-file <path> is required; policy decisions must use a preserved raw report",
  );
}
const parsedAudit = auditEvents(
  readFileSync(resolve(process.argv[auditIndex + 1]), "utf8"),
);
const auditResult = classifyAudit(
  parsedAudit.events,
  graph,
  locatorCategories,
  modeEvidence,
);
const versionResult = verifyVersionContract(graph);
const findings = [
  ...versionResult.findings,
  ...Object.values(closure).flatMap((value) =>
    value.unmapped.map(
      (entry) =>
        `unmapped ${value.category} import ${entry.name}@${entry.range ?? "<missing>"} from ${entry.parent}`,
    ),
  ),
  ...parsedAudit.invalid.map((line) => `invalid audit JSON at line ${line}`),
  ...sourceEvidence.forbiddenImports.map(
    (entry) =>
      `${entry.path}:${entry.line} activates RSC mode through ${entry.kind} ${entry.specifier}`,
  ),
  ...sourceEvidence.configFindings,
  ...artifactEvidence.findings,
  ...auditResult.findings,
];
const report = {
  schema: "myoxus-release-dependency-policy-v1",
  advisories: auditResult.advisories,
  closure,
  exactDependencyVersions: Object.fromEntries(exactDependencyVersions),
  exactResolvedVersions: Object.fromEntries(exactResolvedVersions),
  resolvedVersionPolicies,
  findings,
  manifestOccurrences: versionResult.occurrences,
  modeEvidence,
  selfTests,
};
const reportIndex = process.argv.indexOf("--report");
const reportPath = resolve(
  reportIndex >= 0 && process.argv[reportIndex + 1]
    ? process.argv[reportIndex + 1]
    : "dist/ci/dependency-health/release-dependency-policy.json",
);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, stableJson(report));

for (const advisory of report.advisories) {
  const categories = [
    ...new Set(advisory.locators.flatMap((locator) => locator.categories)),
  ].sort();
  console.log(
    `${advisory.severity} ${advisory.name}: ${categories.join(", ")}${advisory.inactivePackageMode ? " (inactive-package-mode)" : ""}`,
  );
}
if (findings.length) {
  for (const finding of findings)
    console.error(`release-dependency-policy: ${finding}`);
  process.exit(1);
}
console.log(
  `Release dependency policy passed (${auditResult.advisories.length} mapped advisories; all High/Critical release closures clean or proven inactive)`,
);
