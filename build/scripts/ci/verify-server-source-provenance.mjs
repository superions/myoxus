#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
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
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPONENT_KEYS = [
  "id",
  "licenseExpression",
  "noticePaths",
  "origin",
  "paths",
  "sha256",
  "upstreamRevision",
  "upstreamUrl",
].sort();
const REQUIRED_COMPONENTS = new Map([
  ["google-fonts-bundle", "server/static/fonts/manifest.json"],
  ["compact-icc-srgb-v4", "server/static/icc/sRGB-v4.icc"],
  [
    "artifex-ghostscript-default-cmyk",
    "server/static/icc/Artifex-CMYK-SWOP.icc",
  ],
  [
    "artifex-ghostscript-postscript-cmyk",
    "server/static/icc/Artifex-PostScript-CMYK.icc",
  ],
]);
const BASELINE = "e31cca33540af2737dc9e520b70acac170c0709e";
const SERVER_INITIAL = "a7aec209f5f2bb0e8b8d90f2a994db7f0c966ad4";
const SERVER_RENAME = "9d9316ca3bf7db10bb4cf48c846ac0b3ef5d8520";
const REMOVAL_COMMITS = ["ec2c50d307", "1d4c0445f1", "ac7526f944"];

function fail(message) {
  throw new Error(message);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function collectFiles(directory, predicate, result = []) {
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(file, predicate, result);
    else if (predicate(file)) result.push(file);
  }
  return result.sort();
}

function validateComponents(root) {
  const manifestPath = path.join(root, "server/provenance/components.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const topKeys = Object.keys(manifest).sort();
  if (
    JSON.stringify(topKeys) !== JSON.stringify(["components", "schemaVersion"])
  ) {
    fail(`component manifest keys mismatch: ${topKeys.join(", ")}`);
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.components)) {
    fail("component manifest must use schemaVersion 1 and a components array");
  }

  const ids = new Set();
  const covered = new Set();
  for (const component of manifest.components) {
    const keys = Object.keys(component).sort();
    if (JSON.stringify(keys) !== JSON.stringify(COMPONENT_KEYS)) {
      fail(
        `${String(component.id)} component keys mismatch: ${keys.join(", ")}`,
      );
    }
    if (!component.id || ids.has(component.id)) {
      fail(`duplicate or empty component id: ${String(component.id)}`);
    }
    ids.add(component.id);
    for (const key of [
      "origin",
      "licenseExpression",
      "upstreamUrl",
      "upstreamRevision",
    ]) {
      if (typeof component[key] !== "string" || !component[key]) {
        fail(`${component.id}.${key} must be a non-empty string`);
      }
    }
    if (!/^https:\/\//.test(component.upstreamUrl)) {
      fail(`${component.id}.upstreamUrl must use HTTPS`);
    }
    for (const key of ["paths", "sha256", "noticePaths"]) {
      if (!Array.isArray(component[key]) || component[key].length === 0) {
        fail(`${component.id}.${key} must be a non-empty array`);
      }
    }
    if (component.paths.length !== component.sha256.length) {
      fail(`${component.id} path and hash arrays must have equal length`);
    }
    for (const noticePath of component.noticePaths) {
      if (
        typeof noticePath !== "string" ||
        path.isAbsolute(noticePath) ||
        noticePath.split("/").includes("..") ||
        !existsSync(path.join(root, noticePath))
      ) {
        fail(`${component.id} notice path is missing: ${String(noticePath)}`);
      }
    }
    component.paths.forEach((relativePath, index) => {
      if (
        typeof relativePath !== "string" ||
        !(
          relativePath.startsWith("server/static/") ||
          relativePath.startsWith("server/templates/pdf/vendor/") ||
          relativePath.startsWith("server/templates/pdf/myoxus-doc/vendor/")
        ) ||
        relativePath.split("/").includes("..") ||
        /[*?<>]/.test(relativePath)
      ) {
        fail(
          `${component.id} has invalid component path: ${String(relativePath)}`,
        );
      }
      const absolutePath = path.join(root, relativePath);
      if (!existsSync(absolutePath))
        fail(`${component.id} path is missing: ${relativePath}`);
      if (!/^[0-9a-f]{64}$/.test(component.sha256[index])) {
        fail(`${component.id} has invalid SHA-256 for ${relativePath}`);
      }
      const actual = sha256(absolutePath);
      if (actual !== component.sha256[index]) {
        fail(`${component.id} SHA-256 mismatch for ${relativePath}: ${actual}`);
      }
      covered.add(relativePath);
    });
  }

  for (const [id, requiredPath] of REQUIRED_COMPONENTS) {
    if (!ids.has(id) || !covered.has(requiredPath)) {
      fail(`required component is not classified: ${id} (${requiredPath})`);
    }
  }
  const iccFiles = collectFiles(path.join(root, "server/static/icc"), (file) =>
    file.endsWith(".icc"),
  );
  for (const file of iccFiles) {
    const relativePath = path.relative(root, file).replaceAll(path.sep, "/");
    if (!covered.has(relativePath))
      fail(`unclassified server ICC asset: ${relativePath}`);
  }
}

function validateCrateLicenses(root) {
  const cratesRoot = path.join(root, "server/crates");
  for (const entry of readdirSync(cratesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(cratesRoot, entry.name, "Cargo.toml");
    if (!existsSync(manifest)) continue;
    const source = readFileSync(manifest, "utf8");
    if (
      !/^license\.workspace\s*=\s*true\s*$/m.test(source) &&
      !/^license\s*=\s*"AGPL-3\.0-or-later"\s*$/m.test(source)
    ) {
      fail(
        `server crate has no explicit AGPL workspace contract: ${path.relative(root, manifest)}`,
      );
    }
  }
}

function validateBundledPdfTemplates(root) {
  const templatesRoot = path.join(root, "server/templates/pdf");
  const cargoSource = readFileSync(
    path.join(root, "server/crates/pdf_export/Cargo.toml"),
    "utf8",
  );
  const rendererVersion = cargoSource.match(
    /^\s*typst\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m,
  )?.[1];
  if (!rendererVersion) fail("could not resolve pinned Typst renderer version");
  const rendererContractSource = readFileSync(
    path.join(root, "server/crates/pdf_export/src/template_v2/mod.rs"),
    "utf8",
  );
  const rendererContractVersion = rendererContractSource.match(
    /pub const TYPST_ENGINE_VERSION:\s*&str\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)";/,
  )?.[1];
  if (rendererContractVersion !== rendererVersion) {
    fail(
      `Typst renderer contract ${String(
        rendererContractVersion,
      )} does not match Cargo dependency ${rendererVersion}`,
    );
  }
  const [rendererMajor, rendererMinor] = rendererVersion.split(".");
  const compatibleVersions = new Set([
    rendererVersion,
    `${rendererMajor}.${rendererMinor}.x`,
  ]);

  for (const entry of readdirSync(templatesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "vendor") continue;
    const templateRoot = path.join(templatesRoot, entry.name);
    const manifestPath = path.join(templateRoot, "manifest.json");
    if (!existsSync(manifestPath)) {
      fail(`bundled PDF template has no manifest: ${entry.name}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.id !== entry.name) {
      fail(`bundled PDF template id/path mismatch: ${entry.name}`);
    }
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.version ?? "")) {
      fail(`${entry.name} manifest version must be stable SemVer`);
    }
    if (
      manifest.engine?.name !== "typst" ||
      !compatibleVersions.has(manifest.engine?.version)
    ) {
      fail(
        `${entry.name} targets ${String(
          manifest.engine?.version,
        )}, renderer is ${rendererVersion}`,
      );
    }
    const provenance = manifest.provenance;
    const presentation = [
      "presentation-clean",
      "presentation-focus",
      "presentation-navigator",
    ].includes(entry.name);
    const expectedLicense =
      entry.name === "myoxus-doc"
        ? "AGPL-3.0-or-later AND MIT-0"
        : presentation
          ? "AGPL-3.0-or-later AND MIT"
          : "AGPL-3.0-or-later";
    // Presentation bundles share the catalog-level vendor tree; the renderer
    // materializes those assets under vendor/ in each exported bundle.
    const assetPath = (relative) =>
      path.join(
        presentation && relative.startsWith("vendor/")
          ? templatesRoot
          : templateRoot,
        relative,
      );
    if (
      provenance?.license_spdx !== expectedLicense ||
      typeof provenance.copyright_notice !== "string" ||
      !provenance.copyright_notice.trim() ||
      !/^https:\/\//.test(provenance.source_url ?? "") ||
      typeof provenance.source_revision !== "string" ||
      !provenance.source_revision.trim()
    ) {
      fail(`${entry.name} has incomplete bundled-template provenance`);
    }
    const bundleFiles = collectFiles(
      templateRoot,
      (file) => path.basename(file) !== "manifest.json",
    ).map((file) =>
      path.relative(templateRoot, file).replaceAll(path.sep, "/"),
    );
    if (presentation) {
      bundleFiles.push(
        ...collectFiles(path.join(templatesRoot, "vendor"), () => true).map(
          (file) =>
            path.relative(templatesRoot, file).replaceAll(path.sep, "/"),
        ),
      );
      bundleFiles.sort();
    }
    const declared = [...(manifest.assets ?? [])].sort();
    if (
      declared.some(
        (file) =>
          typeof file !== "string" ||
          path.isAbsolute(file) ||
          file.split("/").includes(".."),
      )
    ) {
      fail(`${entry.name} has an unsafe asset path`);
    }
    if (entry.name === "myoxus-doc") {
      const notice = readFileSync(assetPath("vendor/NOTICE"), "utf8");
      const hash = sha256(assetPath("vendor/ilm.typ"));
      if (
        provenance.source_url !== "https://github.com/talal/ilm" ||
        !notice.includes(provenance.source_revision) ||
        !notice.includes(`Bundled ilm.typ SHA-256: ${hash}`) ||
        !provenance.notice?.includes(hash) ||
        !readFileSync(assetPath("vendor/LICENSE"), "utf8").includes(
          "MIT No Attribution",
        )
      ) {
        fail(
          "myoxus-doc vendor provenance does not match its bundled source/license",
        );
      }
    }
    if (presentation) {
      const notice = readFileSync(assetPath("vendor/NOTICE"), "utf8");
      if (
        !notice.includes(provenance.source_url) ||
        !notice.includes(provenance.source_revision.replace(/^sha256:/, ""))
      ) {
        fail(`${entry.name} vendor notice differs from manifest provenance`);
      }
      for (const dependency of ["touying/0.7.4", "uniwarn/0.1.1"]) {
        if (
          !readFileSync(
            assetPath(`vendor/${dependency}/LICENSE`),
            "utf8",
          ).includes("Permission is hereby granted")
        ) {
          fail(
            `${entry.name} lacks the upstream MIT license for ${dependency}`,
          );
        }
      }
    }
    if (JSON.stringify(bundleFiles) !== JSON.stringify(declared)) {
      fail(
        `${entry.name} manifest assets do not match bundle files: ${declared.join(
          ", ",
        )}`,
      );
    }
    for (const file of bundleFiles.filter((relative) =>
      relative.endsWith(".typ"),
    )) {
      const upstream =
        (entry.name === "myoxus-doc" && file === "vendor/ilm.typ") ||
        (presentation &&
          (file.startsWith("vendor/touying/0.7.4/") ||
            file.startsWith("vendor/uniwarn/0.1.1/")));
      if (upstream) continue; // Upstream licenses remain intact; do not relabel vendor sources.
      const source = readFileSync(assetPath(file), "utf8");
      if (!source.startsWith("// SPDX-License-Identifier: AGPL-3.0-or-later")) {
        fail(`${entry.name}/${file} has no AGPL SPDX header`);
      }
    }
  }
}

function validateRestrictedReferences(root) {
  const extensions = new Set([
    ".rs",
    ".toml",
    ".yaml",
    ".yml",
    ".sql",
    ".sh",
    ".mjs",
    ".ts",
  ]);
  const files = collectFiles(
    path.join(root, "server"),
    (file) =>
      extensions.has(path.extname(file)) &&
      !file.includes(`${path.sep}target${path.sep}`),
  );
  for (const file of files) {
    const activeLines = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:\/\/|--|#)/.test(line));
    if (
      activeLines.some(
        (line) =>
          line.includes("packages/backend") ||
          line.includes("packages/common/native"),
      )
    ) {
      fail(
        `restricted upstream source reference in ${path.relative(root, file)}`,
      );
    }
  }
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function validateArchivedHistory(root) {
  for (const revision of [
    BASELINE,
    SERVER_INITIAL,
    SERVER_RENAME,
    ...REMOVAL_COMMITS,
  ]) {
    git(root, ["cat-file", "-e", `${revision}^{commit}`]);
  }
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", BASELINE, SERVER_INITIAL],
    {
      cwd: root,
      stdio: "ignore",
    },
  );
  const baselineServer = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    BASELINE,
    "--",
    "server",
    "servers/rust",
  ]);
  if (baselineServer)
    fail("Rust server unexpectedly exists at the upstream fork baseline");
  if (
    !git(root, [
      "ls-tree",
      "-r",
      "--name-only",
      SERVER_INITIAL,
      "--",
      "servers/rust/Cargo.toml",
    ])
  ) {
    fail(
      "initial Myoxus Rust server commit does not contain servers/rust/Cargo.toml",
    );
  }
  if (
    !git(root, [
      "ls-tree",
      "-r",
      "--name-only",
      SERVER_RENAME,
      "--",
      "server/Cargo.toml",
    ])
  ) {
    fail("server rename commit does not contain server/Cargo.toml");
  }
  const restrictedAtHead = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    "packages/backend",
    "packages/common/native",
  ]);
  if (restrictedAtHead)
    fail(`restricted upstream trees remain at HEAD:\n${restrictedAtHead}`);
}

// The archive owns original source-history evidence. New builds must remain
// independent of those objects and may only descend from the reviewed clean roots.
function validateHistory(root) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]) !== "false") {
    fail("source provenance requires a full Myoxus checkout (fetch-depth: 0)");
  }
  const allowed = new Set([
    "29f4753d958b66868724a4def321b6f52f89ee35",
    "361978bac7e9ea30442cc9b4134c4a0ee9e45c93",
  ]);
  const roots = git(root, ["rev-list", "--max-parents=0", "HEAD"]).split("\n");
  if (roots.length !== allowed.size || roots.some((id) => !allowed.has(id))) {
    fail("source history contains an unapproved root or lacks a reviewed root");
  }
  const restricted = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    "packages/backend",
    "packages/common/native",
  ]);
  if (restricted)
    fail(`restricted upstream trees remain at HEAD: ${restricted}`);
}

export function validateServerProvenance(
  root,
  { history = true, fontAudit = true } = {},
) {
  validateCrateLicenses(root);
  validateBundledPdfTemplates(root);
  validateComponents(root);
  validateRestrictedReferences(root);
  if (history) validateHistory(root);
  if (fontAudit) {
    execFileSync("bash", ["build/scripts/ci/audit-fonts.sh"], {
      cwd: root,
      stdio: "inherit",
    });
  }
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "myoxus-server-provenance-"));
  mkdirSync(path.join(root, "server/crates/example/src"), { recursive: true });
  mkdirSync(path.join(root, "server/static/fonts"), { recursive: true });
  mkdirSync(path.join(root, "server/static/icc"), { recursive: true });
  mkdirSync(path.join(root, "server/provenance"), { recursive: true });
  mkdirSync(path.join(root, "server/crates/pdf_export/src/template_v2"), {
    recursive: true,
  });
  mkdirSync(path.join(root, "server/templates/pdf"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "server/crates/example/Cargo.toml"),
    '[package]\nname = "example"\nlicense.workspace = true\n',
  );
  writeFileSync(
    path.join(root, "server/crates/example/src/lib.rs"),
    "pub fn clean() {}\n",
  );
  writeFileSync(
    path.join(root, "server/crates/pdf_export/Cargo.toml"),
    '[package]\nname = "pdf-export-fixture"\nlicense.workspace = true\n\n[dependencies]\ntypst = "0.13.1"\n',
  );
  writeFileSync(
    path.join(root, "server/crates/pdf_export/src/template_v2/mod.rs"),
    'pub const TYPST_ENGINE_VERSION: &str = "0.13.1";\n',
  );
  writeFileSync(path.join(root, "server/static/fonts/manifest.json"), "{}\n");
  mkdirSync(path.join(root, "docs/ops/configuration"), { recursive: true });
  writeFileSync(
    path.join(root, "docs/ops/configuration/font-provenance.md"),
    "fonts\n",
  );
  writeFileSync(path.join(root, "server/static/icc/sRGB-v4.icc"), "srgb\n");
  writeFileSync(
    path.join(root, "server/static/icc/Artifex-CMYK-SWOP.icc"),
    "swop\n",
  );
  writeFileSync(
    path.join(root, "server/static/icc/Artifex-PostScript-CMYK.icc"),
    "postscript\n",
  );
  writeFileSync(path.join(root, "server/static/icc/LICENSE"), "cc0\n");
  writeFileSync(
    path.join(root, "server/static/icc/NOTICE-Artifex-Ghostscript.md"),
    "notice\n",
  );
  const definitions = [
    [
      "google-fonts-bundle",
      "server/static/fonts/manifest.json",
      "docs/ops/configuration/font-provenance.md",
    ],
    [
      "compact-icc-srgb-v4",
      "server/static/icc/sRGB-v4.icc",
      "server/static/icc/LICENSE",
    ],
    [
      "artifex-ghostscript-default-cmyk",
      "server/static/icc/Artifex-CMYK-SWOP.icc",
      "server/static/icc/NOTICE-Artifex-Ghostscript.md",
    ],
    [
      "artifex-ghostscript-postscript-cmyk",
      "server/static/icc/Artifex-PostScript-CMYK.icc",
      "server/static/icc/NOTICE-Artifex-Ghostscript.md",
    ],
  ];
  const manifest = {
    schemaVersion: 1,
    components: definitions.map(([id, relativePath, noticePath]) => ({
      id,
      paths: [relativePath],
      origin: "T1",
      licenseExpression: "MIT",
      upstreamUrl: "https://example.invalid/source",
      upstreamRevision: "fixture",
      sha256: [sha256(path.join(root, relativePath))],
      noticePaths: [noticePath],
    })),
  };
  writeFileSync(
    path.join(root, "server/provenance/components.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
}

function expectFailure(label, mutate, pattern) {
  const root = createFixture();
  try {
    mutate(root);
    try {
      validateServerProvenance(root, { history: false, fontAudit: false });
      fail(`${label} fixture did not fail`);
    } catch (error) {
      if (!pattern.test(String(error.message))) throw error;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function templateFixture(root) {
  const source = path.join(process.cwd(), "server/templates/pdf/myoxus-doc");
  const target = path.join(root, "server/templates/pdf/myoxus-doc");
  cpSync(source, target, { recursive: true });
  const manifestPath = path.join(target, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.engine.version = "0.13.1";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return target;
}

function selfTest() {
  const clean = createFixture();
  try {
    templateFixture(clean);
    validateServerProvenance(clean, { history: false, fontAudit: false });
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
  expectFailure(
    "missing license",
    (root) => {
      writeFileSync(
        path.join(root, "server/crates/example/Cargo.toml"),
        '[package]\nname = "example"\n',
      );
    },
    /no explicit AGPL/,
  );
  expectFailure(
    "unknown asset",
    (root) => {
      writeFileSync(
        path.join(root, "server/static/icc/unknown.icc"),
        "unknown\n",
      );
    },
    /unclassified server ICC asset/,
  );
  expectFailure(
    "wrong hash",
    (root) => {
      writeFileSync(
        path.join(root, "server/static/icc/sRGB-v4.icc"),
        "changed\n",
      );
    },
    /SHA-256 mismatch/,
  );
  expectFailure(
    "missing notice",
    (root) => {
      rmSync(path.join(root, "server/static/icc/LICENSE"));
    },
    /notice path is missing/,
  );
  expectFailure(
    "restricted source",
    (root) => {
      writeFileSync(
        path.join(root, "server/crates/example/src/lib.rs"),
        'const SOURCE: &str = "packages/backend/server";\n',
      );
    },
    /restricted upstream source reference/,
  );
  expectFailure(
    "changed vendor source",
    (root) => {
      const target = templateFixture(root);
      writeFileSync(path.join(target, "vendor/ilm.typ"), "changed");
    },
    /vendor provenance/,
  );
  expectFailure(
    "missing upstream license",
    (root) => {
      const target = templateFixture(root);
      writeFileSync(path.join(target, "vendor/LICENSE"), "unclassified");
    },
    /vendor provenance/,
  );
  expectFailure(
    "incorrect license expression",
    (root) => {
      const target = templateFixture(root);
      const file = path.join(target, "manifest.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.provenance.license_spdx = "AGPL-3.0-or-later";
      writeFileSync(file, JSON.stringify(manifest));
    },
    /incomplete bundled-template provenance/,
  );
  console.log(
    "Server source provenance guard self-test passed (8 negative fixtures).",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--self-test")) selfTest();
    else if (process.argv.includes("--archive-history-only")) {
      validateArchivedHistory(process.cwd());
      console.log("Archived source-history evidence verified.");
    } else {
      validateServerProvenance(process.cwd(), {
        history: !process.argv.includes("--source-tree"),
      });
      console.log("Server source provenance guard passed.");
    }
  } catch (error) {
    console.error(`Server source provenance guard failed: ${error.message}`);
    process.exitCode = 1;
  }
}
