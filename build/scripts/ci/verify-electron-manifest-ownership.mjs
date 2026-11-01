// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const manifests = {
  root: "package.json",
  electron: "client/apps/electron/package.json",
  renderer: "client/apps/electron-renderer/package.json",
  contract: "client/libs/desktop-api-contract/package.json",
};
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const forbiddenByOwner = {
  renderer: new Set([
    "@myoxus-tools/utils",
    "@sentry/react",
    "async-call-rpc",
    "cross-env",
    "webm-muxer",
  ]),
  contract: new Set(["async-call-rpc"]),
  electron: new Set([
    "@electron-forge/cli",
    "@electron-forge/core",
    "@electron-forge/maker-dmg",
    "@electron-forge/maker-squirrel",
    "@electron-forge/maker-zip",
    "@electron-forge/plugin-auto-unpack-natives",
    "@electron-forge/shared-types",
    "@types/set-cookie-parser",
    "@types/uuid",
    "@vitejs/plugin-react-swc",
    "app-builder-lib",
    "dmg-builder",
    "electron-builder-squirrel-windows",
    "electron-squirrel-startup",
    "fs-extra",
    "glob",
    "uuid",
    "vite",
  ]),
};
const toolingProofs = {
  electron: new Set(["cross-env", "typescript", "vitest"]),
  renderer: new Set(["@types/react", "@types/react-dom", "typescript"]),
  contract: new Set(),
};

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function directDependencies(manifest) {
  return new Set(
    dependencySections.flatMap((section) =>
      Object.keys(manifest[section] ?? {}),
    ),
  );
}

function moduleName(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:")
  ) {
    return null;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

function sourceFiles(root, relativeRoots) {
  const files = [];
  const ignored = new Set(["dist", "node_modules", "out"]);
  function visit(candidate) {
    const absolute = path.join(root, candidate);
    const entries = readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const relative = path.join(candidate, entry.name);
      if (entry.isDirectory()) visit(relative);
      else if (sourceExtensions.has(path.extname(entry.name)))
        files.push(relative);
    }
  }
  for (const relativeRoot of relativeRoots) visit(relativeRoot);
  return files;
}

function importedModules(root, files) {
  const modules = new Set();
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(|\brequire(?:\.resolve)?\s*\(|\bimport\s+)["']([^"']+)["']/g;
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(pattern)) {
      const name = moduleName(match[1]);
      if (name) modules.add(name);
    }
  }
  return modules;
}

function validate(root, fixtureImports = {}) {
  const findings = [];
  const rootManifest = readJson(root, manifests.root);
  const yarnConfigSource = readFileSync(path.join(root, ".yarnrc.yml"), "utf8");
  parseYaml(yarnConfigSource);
  const ownerManifests = Object.fromEntries(
    Object.entries(manifests)
      .filter(([owner]) => owner !== "root")
      .map(([owner, manifestPath]) => [owner, readJson(root, manifestPath)]),
  );

  const rootElectronOwners = dependencySections.filter((section) =>
    Object.hasOwn(rootManifest[section] ?? {}, "electron"),
  );
  if (rootElectronOwners.length) {
    findings.push(
      `package.json must not own electron (${rootElectronOwners.join(", ")})`,
    );
  }
  if (
    !Object.hasOwn(ownerManifests.electron.devDependencies ?? {}, "electron")
  ) {
    findings.push(
      "client/apps/electron/package.json must directly own electron",
    );
  }
  if ((rootManifest.workspaces ?? []).includes("client/libs/graphql")) {
    findings.push(
      "package.json contains redundant workspace client/libs/graphql",
    );
  }
  if (Object.hasOwn(ownerManifests.electron, "exports")) {
    findings.push("Electron manifest must not export source subpaths");
  }
  if (
    /app-builder-lib|dmg-builder|electron-builder-squirrel-windows/.test(
      yarnConfigSource,
    )
  ) {
    findings.push(
      ".yarnrc.yml must not retain removed installer peer metadata",
    );
  }

  const nested = [];
  const electronRoot = path.join(root, "client/apps/electron");
  function collectNested(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        ["dist", "lib", "node_modules", "out"].includes(entry.name)
      ) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collectNested(absolute);
      else if (
        entry.name === "package.json" &&
        absolute !== path.join(electronRoot, "package.json")
      ) {
        nested.push(path.relative(root, absolute).replaceAll("\\", "/"));
      }
    }
  }
  collectNested(electronRoot);
  // Descriptive license metadata does not change this ESM-only boundary.
  // Dependencies, scripts and other operational package fields still fail.
  if (
    nested.length !== 1 ||
    nested[0] !== "client/apps/electron/scripts/package.json" ||
    JSON.stringify(
      Object.fromEntries(
        Object.entries(readJson(root, nested[0])).filter(
          ([key]) => key !== "license",
        ),
      ),
    ) !== JSON.stringify({ type: "module" })
  ) {
    findings.push(
      `Electron nested manifest contract differs: ${nested.join(", ")}`,
    );
  }

  const sourceRoots = {
    electron: [
      "client/apps/electron/src",
      "client/apps/electron/scripts",
      "client/apps/electron/test",
    ],
    renderer: ["client/apps/electron-renderer/src"],
    contract: ["client/libs/desktop-api-contract/src"],
  };
  const extraFiles = {
    electron: ["client/apps/electron/vitest.config.mts"],
    renderer: [],
    contract: [],
  };
  for (const owner of ["electron", "renderer", "contract"]) {
    const dependencies = directDependencies(ownerManifests[owner]);
    const imports = fixtureImports[owner]
      ? new Set(fixtureImports[owner])
      : importedModules(root, [
          ...sourceFiles(root, sourceRoots[owner]),
          ...extraFiles[owner],
        ]);
    for (const forbidden of forbiddenByOwner[owner]) {
      if (dependencies.has(forbidden)) {
        findings.push(
          `${owner} retains forbidden direct dependency ${forbidden}`,
        );
      }
    }
    for (const dependency of dependencies) {
      if (!imports.has(dependency) && !toolingProofs[owner].has(dependency)) {
        findings.push(
          `${owner} direct dependency has no consumer: ${dependency}`,
        );
      }
    }
  }

  const lock = readFileSync(path.join(root, "yarn.lock"), "utf8");
  if (lock.includes('"@electron-forge/')) {
    findings.push("lock retains retired Electron Forge locators");
  }
  for (const locator of [
    "@electron-forge/maker-squirrel",
    "electron-builder-squirrel-windows",
    "electron-squirrel-startup",
    "electron-winstaller",
  ]) {
    if (lock.includes(`"${locator}@`))
      findings.push(`lock retains Squirrel locator ${locator}`);
  }
  return findings;
}

function writeJson(root, relativePath, value) {
  writeFileSync(
    path.join(root, relativePath),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function assertNegativeFixtures() {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "myoxus-electron-manifest-"),
  );
  try {
    // Copying the small manifest/source surface keeps fixtures independent of
    // product paths while exercising the same validator.
    const copy = (relativePath) => {
      const target = path.join(fixtureRoot, relativePath);
      const source = path.join(repoRoot, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    };
    for (const relativePath of [
      ".yarnrc.yml",
      "package.json",
      "yarn.lock",
      "client/apps/electron/package.json",
      "client/apps/electron/scripts/package.json",
      "client/apps/electron-renderer/package.json",
      "client/libs/desktop-api-contract/package.json",
    ])
      copy(relativePath);

    const imports = Object.fromEntries(
      ["electron", "renderer", "contract"].map((owner) => [
        owner,
        [...directDependencies(readJson(fixtureRoot, manifests[owner]))],
      ]),
    );
    const electron = readJson(fixtureRoot, manifests.electron);
    const root = readJson(fixtureRoot, manifests.root);

    const baselineFindings = validate(fixtureRoot, imports);
    if (baselineFindings.length) {
      throw new Error(
        `manifest fixture baseline is invalid: ${baselineFindings.join(", ")}`,
      );
    }

    root.devDependencies = { ...root.devDependencies, electron: "1.0.0" };
    writeJson(fixtureRoot, manifests.root, root);
    if (
      !validate(fixtureRoot, imports).some((finding) =>
        finding.includes("must not own electron"),
      )
    ) {
      throw new Error("second Electron owner fixture did not fail");
    }
    delete root.devDependencies.electron;
    writeJson(fixtureRoot, manifests.root, root);

    const lockPath = path.join(fixtureRoot, "yarn.lock");
    const baselineLock = readFileSync(lockPath, "utf8");
    writeFileSync(
      lockPath,
      `${baselineLock}\n"electron-builder-squirrel-windows@npm:26.15.3":\n  version: 26.15.3\n`,
    );
    if (
      !validate(fixtureRoot, imports).some((finding) =>
        finding.includes(
          "lock retains Squirrel locator electron-builder-squirrel-windows",
        ),
      )
    ) {
      throw new Error("Squirrel lock locator fixture did not fail");
    }
    writeFileSync(lockPath, baselineLock);

    electron.devDependencies["dead-fixture"] = "1.0.0";
    writeJson(fixtureRoot, manifests.electron, electron);
    if (
      !validate(fixtureRoot, imports).some((finding) =>
        finding.includes("dead-fixture"),
      )
    ) {
      throw new Error("dead direct dependency fixture did not fail");
    }
    delete electron.devDependencies["dead-fixture"];
    writeJson(fixtureRoot, manifests.electron, electron);

    root.workspaces.push("client/libs/graphql");
    writeJson(fixtureRoot, manifests.root, root);
    if (
      !validate(fixtureRoot, imports).some((finding) =>
        finding.includes("redundant workspace"),
      )
    ) {
      throw new Error("redundant workspace fixture did not fail");
    }
    root.workspaces = root.workspaces.filter(
      (entry) => entry !== "client/libs/graphql",
    );

    electron.exports = { "./source": "./src/source.ts" };
    writeJson(fixtureRoot, manifests.electron, electron);
    writeJson(fixtureRoot, manifests.root, root);
    if (
      !validate(fixtureRoot, imports).some((finding) =>
        finding.includes("export source"),
      )
    ) {
      throw new Error("source export fixture did not fail");
    }
    delete electron.exports;
    writeJson(fixtureRoot, manifests.electron, electron);

    const scriptsManifest = readJson(
      fixtureRoot,
      "client/apps/electron/scripts/package.json",
    );
    scriptsManifest.dependencies = { "nested-fixture": "1.0.0" };
    writeJson(
      fixtureRoot,
      "client/apps/electron/scripts/package.json",
      scriptsManifest,
    );
    if (
      !validate(fixtureRoot, imports).some((finding) =>
        finding.includes("nested manifest contract differs"),
      )
    ) {
      throw new Error("nested manifest fixture did not fail");
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

assertNegativeFixtures();
const findings = validate(repoRoot);
if (findings.length) {
  console.error("Electron manifest ownership violations:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log("Electron manifest ownership valid");
