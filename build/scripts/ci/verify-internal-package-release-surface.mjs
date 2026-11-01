#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const INTERNAL_ROOTS = ["client", "tools", "tests/client"];
const ELECTRON_MANIFEST = "client/apps/electron/package.json";
const ELECTRON_SCRIPT_SCOPE = "client/apps/electron/scripts/package.json";
// Workspaces covered by client/provenance/components.json. Once a workspace
// is classified there, missing license metadata is no longer tolerated here.
const PROVENANCE_SCOPED_ROOTS = [
  "client/libs",
  "client/web",
  "client/admin",
  "client/branding",
];
const PROVENANCE_MANIFEST = "client/provenance/components.json";

function isProvenanceScoped(manifestPath) {
  return PROVENANCE_SCOPED_ROOTS.some(
    (root) =>
      manifestPath === `${root}/package.json` ||
      manifestPath.startsWith(`${root}/`),
  );
}
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function readManifest(repoRoot, manifestPath) {
  return JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8"));
}

function collectManifests(repoRoot, roots) {
  const manifests = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        ["node_modules", ".yarn", "dist", "lib", "out"].includes(entry.name)
      ) {
        continue;
      }

      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.name === "package.json") {
        manifests.push(relative(repoRoot, absolutePath).replaceAll("\\", "/"));
      }
    }
  }

  for (const root of roots) {
    visit(join(repoRoot, root));
  }
  return manifests.sort();
}

function validateReleaseSurface(repoRoot) {
  const findings = [];
  const rootManifest = readManifest(repoRoot, "package.json");
  const electronManifest = readManifest(repoRoot, ELECTRON_MANIFEST);
  const manifests = collectManifests(repoRoot, INTERNAL_ROOTS);
  const workspaceNames = new Set(
    [...manifests, ...collectManifests(repoRoot, ["virgultum"])]
      .map((path) => readManifest(repoRoot, path).name)
      .filter((name) => typeof name === "string"),
  );
  const internalManifests = manifests.filter(
    (path) => path !== ELECTRON_MANIFEST && path !== ELECTRON_SCRIPT_SCOPE,
  );
  const workspaceManifests = manifests.filter(
    (path) => path !== ELECTRON_SCRIPT_SCOPE,
  );
  const missingLicenses = [];

  if (typeof rootManifest.version !== "string" || !rootManifest.version) {
    findings.push("package.json must declare the client release version");
  }
  if (
    typeof electronManifest.version !== "string" ||
    !electronManifest.version
  ) {
    findings.push(
      `${ELECTRON_MANIFEST} must declare the desktop release version`,
    );
  }
  for (const manifestPath of workspaceManifests) {
    const manifest = readManifest(repoRoot, manifestPath);
    if (
      manifestPath !== ELECTRON_MANIFEST &&
      Object.hasOwn(manifest, "version")
    ) {
      findings.push(`${manifestPath} must not declare version`);
    }
    if (manifest.private !== true) {
      findings.push(`${manifestPath} must declare private: true`);
    }
    if (Object.hasOwn(manifest, "publishConfig")) {
      findings.push(`${manifestPath} must not declare publishConfig`);
    }
    if (!Object.hasOwn(manifest, "license")) {
      if (isProvenanceScoped(manifestPath)) {
        findings.push(
          `${manifestPath} must declare license; provenance-classified workspaces require explicit license metadata (see ${PROVENANCE_MANIFEST})`,
        );
      } else {
        missingLicenses.push(manifestPath);
      }
    }

    for (const [scriptName, command] of Object.entries(
      manifest.scripts ?? {},
    )) {
      if (
        /^(pre|post)?publish(?:only)?$/i.test(scriptName) ||
        /\b(?:npm|yarn npm)\s+publish\b/.test(String(command))
      ) {
        findings.push(`${manifestPath} contains publish script ${scriptName}`);
      }
    }

    for (const section of DEPENDENCY_SECTIONS) {
      for (const [dependency, range] of Object.entries(
        manifest[section] ?? {},
      )) {
        if (workspaceNames.has(dependency) && range !== "workspace:*") {
          findings.push(
            `${manifestPath} ${section}.${dependency} must use workspace:*`,
          );
        }
      }
    }
  }

  return { findings, internalManifests, missingLicenses };
}

function writeFixture(repoRoot, path, manifest) {
  mkdirSync(join(repoRoot, path, ".."), { recursive: true });
  writeFileSync(join(repoRoot, path), `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertNegativeFixtures() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "myoxus-release-surface-"));
  try {
    writeFixture(fixtureRoot, "package.json", {
      name: "fixture-root",
      version: "1.2.3",
      private: true,
    });
    writeFixture(fixtureRoot, ELECTRON_MANIFEST, {
      name: "@myoxus/electron",
      version: "1.2.3",
      private: true,
    });
    writeFixture(fixtureRoot, "client/libs/example/package.json", {
      name: "@myoxus/example",
      license: "AGPL-3.0-or-later",
      private: true,
    });
    writeFixture(fixtureRoot, "tools/example/package.json", {
      name: "@myoxus-tools/example",
      private: true,
    });
    writeFixture(fixtureRoot, "tests/client/example/app/package.json", {
      name: "@myoxus-test/example",
      private: true,
    });
    writeFixture(fixtureRoot, "virgultum/example/package.json", {
      name: "@virgultum/example",
      version: "1.0.0",
    });

    const clean = validateReleaseSurface(fixtureRoot);
    if (clean.findings.length !== 0) {
      throw new Error(`valid fixture failed: ${clean.findings.join("; ")}`);
    }

    writeFixture(fixtureRoot, "client/libs/example/package.json", {
      name: "@myoxus/example",
      license: "AGPL-3.0-or-later",
      version: "1.2.3",
      private: true,
    });
    const versionFindings = validateReleaseSurface(fixtureRoot).findings;
    if (
      !versionFindings.some((finding) =>
        finding.includes("must not declare version"),
      )
    ) {
      throw new Error("version negative fixture did not fail");
    }

    writeFixture(fixtureRoot, "client/libs/example/package.json", {
      name: "@myoxus/example",
      license: "AGPL-3.0-or-later",
      private: false,
    });
    const privateFindings = validateReleaseSurface(fixtureRoot).findings;
    if (!privateFindings.some((finding) => finding.includes("private: true"))) {
      throw new Error("private negative fixture did not fail");
    }

    writeFixture(fixtureRoot, "client/libs/example/package.json", {
      name: "@myoxus/example",
      private: true,
    });
    const provenanceLicenseFindings =
      validateReleaseSurface(fixtureRoot).findings;
    if (
      !provenanceLicenseFindings.some((finding) =>
        finding.includes(
          "provenance-classified workspaces require explicit license",
        ),
      )
    ) {
      throw new Error(
        "provenance-scoped missing-license negative fixture did not fail",
      );
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

assertNegativeFixtures();
const result = validateReleaseSurface(process.cwd());
if (result.findings.length > 0) {
  console.error("Internal package release-surface violations:");
  for (const finding of result.findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `Internal package release surface valid: ${result.internalManifests.length} private versionless workspaces; root and Electron release authorities declared.`,
);
if (result.missingLicenses.length > 0) {
  console.log(
    `${result.missingLicenses.length} manifests intentionally retain missing license metadata; see docs/provenance-inventory.md.`,
  );
}
