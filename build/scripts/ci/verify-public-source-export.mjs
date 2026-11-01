#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { validateProvenance as validateClientProvenance } from "./verify-client-source-provenance.mjs";
import { verifyPublicUrlOwnership } from "./verify-public-url-ownership.mjs";
import { validateServerProvenance } from "./verify-server-source-provenance.mjs";
import { verifyVirgultumProvenance } from "./verify-virgultum-source-provenance.mjs";
import { scanForSecrets } from "./scan-public-source-secrets.mjs";

const REQUIRED_TOP_LEVEL = [
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "Cargo.toml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/copilot-instructions.md",
  "package.json",
  ".yarnrc.yml",
  "docs/provenance-inventory.md",
  "server/provenance/components.json",
  "client/REUSE.toml",
  "client/provenance/components.json",
  "client/provenance/LICENSE-UPSTREAM-MIT.txt",
  "virgultum/provenance/licenses.json",
];
const REQUIRED_PRODUCT_PREFIXES = [
  "server/",
  "client/admin/",
  "client/web/",
  "client/apps/electron/",
  "client/apps/electron-renderer/",
];
const REQUIRED_EXCLUDED_PRODUCT_METADATA = [
  "client/apps/android/package.json",
  "client/apps/ios/package.json",
  "client/apps/mobile/package.json",
  "client/apps/mobile-shared/package.json",
  "tests/client/mobile/app/package.json",
];
const FORBIDDEN_PREFIXES = [
  "server/crates/tests/reports/",
  "todo/",
  "learnings/",
  "docs/dev/legacy-server/",
  "docs/test/",
  "server/archive/",
  "server/runtime/",
  "client/frontends/static/",
  "client/apps/android/",
  "client/apps/ios/",
  "client/apps/mobile/",
  "client/apps/mobile-shared/",
  "client/apps/mobile-native/",
  "tests/client/mobile/",
  "server/crates/api/test-storage/",
  "tests/client/shared/fixtures/alpha/",
  "virgultum/icons/dist/",
  ".github/workflows/",
];
const FORBIDDEN_DIRECTORY_ENTRIES = [
  "server/crates/tests/reports/",
  "todo/",
  "learnings/",
  "docs/test/",
  "client/apps/mobile-native/",
  "server/crates/api/test-storage/",
  "tests/client/shared/fixtures/alpha/",
  "virgultum/icons/dist/",
  ".github/workflows/",
];

function sha256OfFile(path) {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

function configuredYarnPath(root) {
  return parseYaml(readFileSync(join(root, ".yarnrc.yml"), "utf8"))?.yarnPath;
}

function parseArgs(argv) {
  const args = { archive: null, selfTest: false };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--self-test") {
      args.selfTest = true;
    } else if (flag === "--archive" && i + 1 < argv.length) {
      args.archive = argv[++i];
    }
  }
  return args;
}

function listArchive(repoRoot, archivePath) {
  const result = spawnSync("tar", ["-tf", archivePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tar -tf failed for ${archivePath}: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\.\//, ""))
    .filter((line) => line.length > 0)
    .sort();
}

function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync("tar", ["-xf", archivePath, "-C", destDir], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tar -xf failed for ${archivePath}: ${result.stderr}`);
  }
}

function validateExport(
  repoRoot,
  archivePath,
  {
    validateClient = validateClientProvenance,
    validateServer = validateServerProvenance,
    validateVirgultum = verifyVirgultumProvenance,
    scanSecrets = scanForSecrets,
    verifyUrls = verifyPublicUrlOwnership,
  } = {},
) {
  const findings = [];

  if (!existsSync(archivePath)) {
    return [`archive does not exist: ${archivePath}`];
  }

  let entries;
  try {
    entries = listArchive(repoRoot, archivePath);
  } catch (error) {
    return [String(error.message ?? error)];
  }

  // Internal planning roots must be absent completely. Even empty directory
  // headers expose internal repository structure. Other excluded product
  // roots can legitimately retain explicitly allow-listed workspace metadata,
  // so their directory headers remain while their source files are checked.
  const fileEntries = entries.filter((entry) => !entry.endsWith("/"));
  for (const entry of FORBIDDEN_DIRECTORY_ENTRIES) {
    if (entries.includes(entry)) {
      findings.push(`archive contains forbidden path: ${entry}`);
    }
  }
  for (const entry of fileEntries) {
    if (
      /^tests\/(?:.*\/)?readme[^/]*$/i.test(entry) ||
      entry === "build/test-matrix/README.md" ||
      entry === "build/scripts/ci/README.md"
    ) {
      findings.push(`archive contains forbidden test documentation: ${entry}`);
    }
    if (REQUIRED_EXCLUDED_PRODUCT_METADATA.includes(entry)) {
      continue;
    }
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (entry === prefix || entry.startsWith(prefix)) {
        findings.push(`archive contains forbidden path: ${entry}`);
      }
    }
  }

  // Required top-level artefacts
  for (const required of REQUIRED_TOP_LEVEL) {
    if (!entries.includes(required)) {
      findings.push(`archive missing required top-level file: ${required}`);
    }
  }
  for (const prefix of REQUIRED_PRODUCT_PREFIXES) {
    if (!fileEntries.some((entry) => entry.startsWith(prefix))) {
      findings.push(`archive missing required product root: ${prefix}`);
    }
  }
  for (const metadataPath of REQUIRED_EXCLUDED_PRODUCT_METADATA) {
    if (!fileEntries.includes(metadataPath)) {
      findings.push(
        `archive missing excluded-product workspace metadata: ${metadataPath}`,
      );
    }
  }

  // Archive must contain a lockfile for reproducibility
  const hasLockfile = entries.some(
    (e) => e === "yarn.lock" || e === "Cargo.lock" || e === "package-lock.json",
  );
  if (!hasLockfile) {
    findings.push("archive is missing a lockfile (yarn.lock or Cargo.lock)");
  }

  // SHA-256 sidecar must match archive hash and must be present
  const shaPath = `${archivePath}.sha256`;
  if (!existsSync(shaPath)) {
    findings.push(`archive sha256 sidecar missing: ${shaPath}`);
  } else {
    const expected = sha256OfFile(archivePath);
    const recorded = readFileSync(shaPath, "utf8").trim();
    if (recorded !== expected) {
      findings.push(
        `archive sha256 mismatch: file ${expected}, sidecar ${recorded}`,
      );
    }
  }

  // Manifest must exist, list the same files as the archive, and per-entry
  // hashes must match the archive contents.
  const manifestPath = `${archivePath}.manifest`;
  if (!existsSync(manifestPath)) {
    findings.push(`archive manifest missing: ${manifestPath}`);
    return findings;
  }

  const manifestLines = readFileSync(manifestPath, "utf8").split("\n");
  const manifestEntries = new Map();
  for (const line of manifestLines) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) {
      findings.push(`manifest line not in sha256<space>path format: ${line}`);
      continue;
    }
    manifestEntries.set(match[2], match[1]);
  }

  // Extract to verify per-entry hashes
  const extractDir = mkdtempSync(join(tmpdir(), "myoxus-export-verify-"));
  try {
    extractArchive(archivePath, extractDir);
    for (const [path, expected] of manifestEntries) {
      const absolute = join(extractDir, path);
      if (!existsSync(absolute)) {
        findings.push(`manifest references missing archive entry: ${path}`);
        continue;
      }
      const actual = sha256OfFile(absolute);
      if (actual !== expected) {
        findings.push(
          `manifest hash mismatch for ${path}: expected ${expected}, got ${actual}`,
        );
      }
    }

    const yarnConfigPath = join(extractDir, ".yarnrc.yml");
    if (existsSync(yarnConfigPath)) {
      try {
        const yarnPath = configuredYarnPath(extractDir);
        if (
          typeof yarnPath !== "string" ||
          !yarnPath.startsWith(".yarn/releases/") ||
          yarnPath.includes("..")
        ) {
          findings.push(
            "archive .yarnrc.yml must bind yarnPath to a bundled .yarn/releases binary",
          );
        } else if (!existsSync(join(extractDir, yarnPath))) {
          findings.push(`archive missing configured Yarn binary: ${yarnPath}`);
        }
      } catch (error) {
        findings.push(
          `archive .yarnrc.yml is not valid YAML: ${String(error.message ?? error)}`,
        );
      }
    }

    const rootCargoPath = join(extractDir, "Cargo.toml");
    if (existsSync(rootCargoPath)) {
      const rootCargo = readFileSync(rootCargoPath, "utf8");
      if (
        rootCargo.includes("client/apps/mobile-native") ||
        rootCargo.includes("myoxus_mobile_native")
      ) {
        findings.push(
          "archive root Cargo.toml references excluded Mobile source",
        );
      }
    }

    for (const finding of validateClient(extractDir)) {
      findings.push(`client provenance: ${finding}`);
    }
    try {
      validateServer(extractDir, {
        history: false,
        fontAudit: false,
      });
    } catch (error) {
      findings.push(`server provenance: ${String(error.message ?? error)}`);
    }
    try {
      validateVirgultum(extractDir, { publicExport: true });
    } catch (error) {
      findings.push(`Virgultum provenance: ${String(error.message ?? error)}`);
    }

    for (const finding of scanSecrets(extractDir)) {
      findings.push(`secret scan: ${finding}`);
    }
    for (const finding of verifyUrls(extractDir)) {
      findings.push(`public URL ownership: ${finding}`);
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }

  // Manifest must contain every archive entry that is a regular file
  for (const entry of fileEntries) {
    if (!manifestEntries.has(entry)) {
      findings.push(`archive file missing from manifest: ${entry}`);
    }
  }

  return findings;
}

function makeTar(archivePath, sourceDir) {
  const result = spawnSync("tar", ["-cf", archivePath, "-C", sourceDir, "."], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tar -cf failed: ${result.stderr}`);
  }
}

function writeManifest(archivePath, entries) {
  const lines = [
    "# myoxus public-source export manifest",
    "# revision: self-test",
    "#",
  ];
  for (const entry of entries.sort()) {
    const abs = join(extractDir, entry);
    if (!existsSync(abs)) continue;
    const hash = sha256OfFile(abs);
    lines.push(`${hash}  ${entry}`);
  }
  writeFileSync(`${archivePath}.manifest`, `${lines.join("\n")}\n`);
  writeFileSync(`${archivePath}.sha256`, `${sha256OfFile(archivePath)}\n`);
}

let extractDir;
const selfTestPaths = new Set();

function buildCleanFixture() {
  extractDir = mkdtempSync(join(tmpdir(), "myoxus-clean-"));
  selfTestPaths.add(extractDir);
  const yarnPath = configuredYarnPath(process.cwd());
  const fixedCopyPaths = [
    "LICENSE",
    "README.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "Cargo.toml",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/copilot-instructions.md",
    "package.json",
    ".yarnrc.yml",
    yarnPath,
    "yarn.lock",
    "docs/provenance-inventory.md",
    "server/provenance/components.json",
    "client/REUSE.toml",
    "client/provenance/components.json",
    "client/provenance/LICENSE-UPSTREAM-MIT.txt",
    "virgultum/provenance/licenses.json",
    "server/Cargo.toml",
    "client/apps/electron/package.json",
    "client/apps/electron-renderer/package.json",
    ...REQUIRED_EXCLUDED_PRODUCT_METADATA,
  ];
  const classification = JSON.parse(
    readFileSync(
      join(process.cwd(), "client/provenance/components.json"),
      "utf8",
    ),
  );
  const trackedRoots = classification.policy.scopedFiles.roots;
  // The client inventory includes desktop source and native materializations
  // whose exact generators/inputs are owned outside the client directories.
  const supportingPaths = classification.components.flatMap((component) => [
    ...(component.noticePaths ?? []),
    ...(component.generatedFrom
      ? [
          component.generatedFrom.generator,
          ...component.generatedFrom.sources.filter(
            (path) => !/[*?]/.test(path),
          ),
        ]
      : []),
  ]);
  const trackedResult = spawnSync(
    "git",
    ["ls-files", "-z", "--", ...trackedRoots],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (trackedResult.status !== 0) {
    throw new Error(`git ls-files failed: ${trackedResult.stderr}`);
  }
  const copyPaths = [
    ...fixedCopyPaths,
    ...trackedResult.stdout.split("\0").filter(Boolean),
    ...supportingPaths,
  ];
  for (const path of copyPaths) {
    const target = join(extractDir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    cpSync(join(process.cwd(), path), target);
  }
  const fixtureCargoPath = join(extractDir, "Cargo.toml");
  writeFileSync(
    fixtureCargoPath,
    readFileSync(fixtureCargoPath, "utf8")
      .replace('  "./client/apps/mobile-native",\n', "")
      .replace(
        /\n  # Android UniFFI binding generation requires exported symbols\.\n  \[profile\.release\.package\.myoxus_mobile_native\]\n  strip = "none"\n/,
        "\n",
      ),
  );
  mkdirSync(join(extractDir, "src"), { recursive: true });
  writeFileSync(join(extractDir, "src", "index.ts"), "export {};\n");
  return extractDir;
}

function listFixtureFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute.slice(root.length + 1));
      }
    }
  }
  return files.sort();
}

function archiveWith(entries, manifest) {
  const archive = join(
    tmpdir(),
    `myoxus-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
  );
  extractDir = mkdtempSync(join(tmpdir(), "myoxus-fixture-src-"));
  selfTestPaths.add(archive);
  selfTestPaths.add(`${archive}.manifest`);
  selfTestPaths.add(`${archive}.sha256`);
  selfTestPaths.add(extractDir);
  for (const [path, content] of Object.entries(entries)) {
    const absolute = join(extractDir, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  makeTar(archive, extractDir);
  if (manifest !== "skip") {
    writeFileSync(`${archive}.manifest`, manifest);
    writeFileSync(`${archive}.sha256`, `${sha256OfFile(archive)}\n`);
  }
  return archive;
}

function assertSelfTest() {
  const structuralOnly = {
    validateClient: () => [],
    validateServer: () => {},
    validateVirgultum: () => {},
    scanSecrets: () => [],
    verifyUrls: () => [],
  };
  const clientOnly = {
    validateServer: () => {},
    validateVirgultum: () => {},
    scanSecrets: () => [],
    verifyUrls: () => [],
  };
  try {
    // Internal test documentation must never become public source content.
    for (const path of [
      "docs/test/README.md",
      "tests/README.md",
      "tests/client/README.md",
      "build/test-matrix/README.md",
      "build/scripts/ci/README.md",
    ]) {
      const testDocsLeak = archiveWith(
        {
          LICENSE: "AGPL\n",
          "yarn.lock": "# lock\n",
          [path]: "internal\n",
        },
        "# manifest\n",
      );
      if (
        !validateExport(process.cwd(), testDocsLeak, structuralOnly).some(
          (finding) => finding.includes("forbidden") && finding.includes(path),
        )
      ) {
        throw new Error(
          "internal test documentation was accepted in the public archive",
        );
      }
    }
    console.log("Internal test documentation leaks rejected (5 paths).");

    // --- Positive: a clean export ---
    buildCleanFixture();
    const archive = join(
      tmpdir(),
      `myoxus-clean-export-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
    );
    selfTestPaths.add(archive);
    selfTestPaths.add(`${archive}.manifest`);
    selfTestPaths.add(`${archive}.sha256`);
    makeTar(archive, extractDir);
    writeManifest(archive, listFixtureFiles(extractDir));
    const clean = validateExport(process.cwd(), archive, {
      validateServer: () => {},
      validateVirgultum: () => {},
    });
    if (clean.length !== 0) {
      throw new Error(`positive fixture failed: ${clean.join("; ")}`);
    }

    // --- Negative: all three extracted-tree validators are delegated ---
    const badDelegationArchive = archiveWith(
      {
        LICENSE: "AGPL\n",
        "yarn.lock": "# lock\n",
        "server/provenance/components.json": "{}\n",
        "virgultum/provenance/licenses.json": "{}\n",
      },
      "# manifest\n",
    );
    const badDelegation = validateExport(process.cwd(), badDelegationArchive, {
      validateClient: () => [],
      scanSecrets: () => [],
      verifyUrls: () => [],
    });
    for (const prefix of ["server provenance:", "Virgultum provenance:"]) {
      if (!badDelegation.some((finding) => finding.includes(prefix))) {
        throw new Error(
          `${prefix} delegation did not fail: ${badDelegation.join("; ")}`,
        );
      }
    }

    // --- Negative: excluded-product workspace metadata is missing ---
    buildCleanFixture();
    const missingWorkspaceMetadata = REQUIRED_EXCLUDED_PRODUCT_METADATA[0];
    rmSync(join(extractDir, missingWorkspaceMetadata));
    const missingWorkspaceMetadataArchive = join(
      tmpdir(),
      `myoxus-missing-workspace-metadata-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
    );
    selfTestPaths.add(missingWorkspaceMetadataArchive);
    selfTestPaths.add(`${missingWorkspaceMetadataArchive}.manifest`);
    selfTestPaths.add(`${missingWorkspaceMetadataArchive}.sha256`);
    makeTar(missingWorkspaceMetadataArchive, extractDir);
    writeManifest(
      missingWorkspaceMetadataArchive,
      listFixtureFiles(extractDir),
    );
    const missingMetadata = validateExport(
      process.cwd(),
      missingWorkspaceMetadataArchive,
      structuralOnly,
    );
    if (
      !missingMetadata.some(
        (finding) =>
          finding.includes("missing excluded-product workspace metadata") &&
          finding.includes(missingWorkspaceMetadata),
      )
    ) {
      throw new Error(
        `missing-workspace-metadata did not fail: ${missingMetadata.join("; ")}`,
      );
    }

    // --- Negative: the configured Yarn binary is missing ---
    buildCleanFixture();
    rmSync(join(extractDir, configuredYarnPath(extractDir)));
    const missingYarnArchive = join(
      tmpdir(),
      `myoxus-missing-yarn-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
    );
    selfTestPaths.add(missingYarnArchive);
    selfTestPaths.add(`${missingYarnArchive}.manifest`);
    selfTestPaths.add(`${missingYarnArchive}.sha256`);
    makeTar(missingYarnArchive, extractDir);
    writeManifest(missingYarnArchive, listFixtureFiles(extractDir));
    const missingYarn = validateExport(
      process.cwd(),
      missingYarnArchive,
      structuralOnly,
    );
    if (
      !missingYarn.some((finding) =>
        finding.includes("missing configured Yarn binary"),
      )
    ) {
      throw new Error(
        `missing-configured-yarn did not fail: ${missingYarn.join("; ")}`,
      );
    }

    // --- Negative: internal, generated, local-evidence, and workflow paths ---
    for (const path of [
      "todo/secret.md",
      "server/crates/tests/reports/legacy-smoke.json",
      "server/crates/api/test-storage/run/output.bin",
      "tests/client/shared/fixtures/alpha/local-evidence.md",
      "virgultum/icons/dist/rc.js",
      ".github/workflows/public-build.yml",
    ]) {
      const leaked = archiveWith(
        {
          LICENSE: "AGPL\n",
          "yarn.lock": "# lock\n",
          [path]: "must not be exported\n",
        },
        "# manifest\n",
      );
      const forbidden = validateExport(process.cwd(), leaked, structuralOnly);
      if (!forbidden.some((finding) => finding.includes(path))) {
        throw new Error(
          `forbidden path was accepted (${path}): ${forbidden.join("; ")}`,
        );
      }
    }

    // --- Negative: excluded Mobile source leaked ---
    buildCleanFixture();
    const mobileLeakPath = join(
      extractDir,
      "client/apps/mobile/src/forbidden.ts",
    );
    mkdirSync(join(mobileLeakPath, ".."), { recursive: true });
    writeFileSync(mobileLeakPath, "export {};\n");
    const mobileLeakArchive = join(
      tmpdir(),
      `myoxus-mobile-leak-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
    );
    selfTestPaths.add(mobileLeakArchive);
    selfTestPaths.add(`${mobileLeakArchive}.manifest`);
    selfTestPaths.add(`${mobileLeakArchive}.sha256`);
    makeTar(mobileLeakArchive, extractDir);
    writeManifest(mobileLeakArchive, listFixtureFiles(extractDir));
    const mobileLeak = validateExport(
      process.cwd(),
      mobileLeakArchive,
      structuralOnly,
    );
    if (
      !mobileLeak.some((finding) => finding.includes("client/apps/mobile/"))
    ) {
      throw new Error(`mobile-prefix did not fail: ${mobileLeak.join("; ")}`);
    }

    // --- Negative: one required product root is missing ---
    buildCleanFixture();
    rmSync(join(extractDir, "client/apps/electron-renderer"), {
      recursive: true,
      force: true,
    });
    const missingProductArchive = join(
      tmpdir(),
      `myoxus-missing-product-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
    );
    selfTestPaths.add(missingProductArchive);
    selfTestPaths.add(`${missingProductArchive}.manifest`);
    selfTestPaths.add(`${missingProductArchive}.sha256`);
    makeTar(missingProductArchive, extractDir);
    writeManifest(missingProductArchive, listFixtureFiles(extractDir));
    const missingProduct = validateExport(
      process.cwd(),
      missingProductArchive,
      structuralOnly,
    );
    if (
      !missingProduct.some(
        (finding) =>
          finding.includes("missing required product root") &&
          finding.includes("client/apps/electron-renderer/"),
      )
    ) {
      throw new Error(
        `missing-product-root did not fail: ${missingProduct.join("; ")}`,
      );
    }

    // --- Negative: missing required top-level file ---
    const incomplete = archiveWith(
      {
        "yarn.lock": "# lock\n",
      },
      "# manifest\n",
    );
    const missingTop = validateExport(
      process.cwd(),
      incomplete,
      structuralOnly,
    );
    if (
      !missingTop.some(
        (f) =>
          f.includes("missing required top-level") && f.includes("LICENSE"),
      )
    ) {
      throw new Error(
        `missing-required did not fail: ${missingTop.join("; ")}`,
      );
    }

    // --- Negative: missing lockfile ---
    const nolock = archiveWith(
      {
        LICENSE: "AGPL\n",
      },
      "# manifest\n",
    );
    const lockMissing = validateExport(process.cwd(), nolock, structuralOnly);
    if (!lockMissing.some((f) => f.includes("missing a lockfile"))) {
      throw new Error(
        `missing-lockfile did not fail: ${lockMissing.join("; ")}`,
      );
    }

    // --- Negative: sha256 sidecar mismatch ---
    const tamper = archiveWith(
      {
        LICENSE: "AGPL\n",
        "yarn.lock": "# lock\n",
      },
      "# manifest\n",
    );
    writeFileSync(`${tamper}.sha256`, "0".repeat(64));
    const tamperedSha = validateExport(process.cwd(), tamper, structuralOnly);
    if (!tamperedSha.some((f) => f.includes("sha256 mismatch"))) {
      throw new Error(
        `sha256-mismatch did not fail: ${tamperedSha.join("; ")}`,
      );
    }

    // --- Negative: missing manifest sidecar ---
    // Build a complete archive (all required top-level + lockfile) but with
    // no manifest sidecar. The only finding must be "manifest missing".
    const noManifest = archiveWith(
      {
        LICENSE: "AGPL\n",
        "yarn.lock": "# lock\n",
        "docs/provenance-inventory.md": "# inventory\n",
        "server/provenance/components.json": "{}\n",
        "client/provenance/components.json": "{}\n",
      },
      "skip",
    );
    const manifestMissing = validateExport(
      process.cwd(),
      noManifest,
      structuralOnly,
    );
    if (!manifestMissing.some((f) => f.includes("manifest missing"))) {
      throw new Error(
        `manifest-missing did not fail: ${manifestMissing.join("; ")}`,
      );
    }

    // --- Negative: manifest hash drift ---
    buildCleanFixture();
    const archive2 = join(
      tmpdir(),
      `myoxus-clean-export2-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
    );
    selfTestPaths.add(archive2);
    selfTestPaths.add(`${archive2}.manifest`);
    selfTestPaths.add(`${archive2}.sha256`);
    makeTar(archive2, extractDir);
    writeManifest(archive2, listFixtureFiles(extractDir));
    const manifestPath = `${archive2}.manifest`;
    const original = readFileSync(manifestPath, "utf8");
    writeFileSync(
      manifestPath,
      original.replace(
        /^([0-9a-f]{64})  LICENSE/m,
        "0000000000000000000000000000000000000000000000000000000000000000  LICENSE",
      ),
    );
    const drifted = validateExport(process.cwd(), archive2, structuralOnly);
    if (!drifted.some((f) => f.includes("manifest hash mismatch"))) {
      throw new Error(`manifest-drift did not fail: ${drifted.join("; ")}`);
    }

    // --- Negative: source archive removed retained upstream attribution ---
    buildCleanFixture();
    const reusePath = join(extractDir, "client", "REUSE.toml");
    writeFileSync(
      reusePath,
      readFileSync(reusePath, "utf8").replace(
        /(SPDX-FileCopyrightText\s*=\s*)"2022-2026 TOEVERYTHING PTE\. LTD\. and its affiliates\."/,
        '$1"2026-present Daniel Scharf and Myoxus contributors"',
      ),
    );
    const missingUpstreamArchive = join(
      tmpdir(),
      `myoxus-missing-upstream-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
    );
    selfTestPaths.add(missingUpstreamArchive);
    selfTestPaths.add(`${missingUpstreamArchive}.manifest`);
    selfTestPaths.add(`${missingUpstreamArchive}.sha256`);
    makeTar(missingUpstreamArchive, extractDir);
    writeManifest(missingUpstreamArchive, listFixtureFiles(extractDir));
    const missingUpstream = validateExport(
      process.cwd(),
      missingUpstreamArchive,
      clientOnly,
    );
    if (
      !missingUpstream.some((finding) =>
        finding.includes("removed required upstream attribution"),
      )
    ) {
      throw new Error(
        `removed-upstream-attribution did not fail: ${missingUpstream.join("; ")}`,
      );
    }

    // --- Negative: source archive asserts Myoxus copyright on third-party code ---
    buildCleanFixture();
    const thirdPartyReusePath = join(extractDir, "client", "REUSE.toml");
    const thirdPartyReuse = readFileSync(thirdPartyReusePath, "utf8");
    const falseMyoxusReuse = thirdPartyReuse.replace(
      /SPDX-FileCopyrightText\s*=\s*"2018 Google LLC"/,
      'SPDX-FileCopyrightText = "2026-present Daniel Scharf and Myoxus contributors"',
    );
    if (falseMyoxusReuse === thirdPartyReuse) {
      throw new Error(
        "false-Myoxus-attribution fixture could not find Google copyright evidence",
      );
    }
    writeFileSync(thirdPartyReusePath, falseMyoxusReuse);
    const falseMyoxusArchive = join(
      tmpdir(),
      `myoxus-false-copyright-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`,
    );
    selfTestPaths.add(falseMyoxusArchive);
    selfTestPaths.add(`${falseMyoxusArchive}.manifest`);
    selfTestPaths.add(`${falseMyoxusArchive}.sha256`);
    makeTar(falseMyoxusArchive, extractDir);
    writeManifest(falseMyoxusArchive, listFixtureFiles(extractDir));
    const falseMyoxus = validateExport(
      process.cwd(),
      falseMyoxusArchive,
      clientOnly,
    );
    if (
      !falseMyoxus.some((finding) =>
        finding.includes("unauthorized upstream/Myoxus attribution"),
      )
    ) {
      throw new Error(
        `false-Myoxus-attribution did not fail: ${falseMyoxus.join("; ")}`,
      );
    }
  } finally {
    for (const path of selfTestPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    selfTestPaths.clear();
  }
}

const args = parseArgs(process.argv);

if (args.selfTest) {
  assertSelfTest();
  console.log("verify-public-source-export self-test passed.");
  process.exit(0);
}

if (!args.archive) {
  console.error(
    "Usage: verify-public-source-export.mjs --archive <path> [--self-test]",
  );
  process.exit(2);
}

const findings = validateExport(process.cwd(), args.archive);
if (findings.length > 0) {
  console.error("Public source export violations:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}
console.log(`Public source export valid: ${args.archive}`);
