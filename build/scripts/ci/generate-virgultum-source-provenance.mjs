// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const GENERATOR = "build/scripts/ci/generate-virgultum-source-provenance.mjs";
const OUTPUT = "virgultum/provenance/licenses.json";
const CUTOFF_REVISION = "e31cca33540af2737dc9e520b70acac170c0709e";
const SOURCES = "virgultum/provenance/sources.json";
const ROOT_FILES = [
  "virgultum/scripts/vitest-global.js",
  "virgultum/tsconfig.json",
];
const PUBLIC_EXPORT_EXCLUDED_PATHS = ["virgultum/icons/dist/**"];
const EMBEDDED_LICENSES = new Map([
  ["virgultum/editor/blocks/surface/src/utils/path-data-parser/LICENSE", "MIT"],
  ["virgultum/editor/blocks/surface/src/utils/points-on-curve/LICENSE", "MIT"],
  ["virgultum/editor/blocks/surface/src/utils/points-on-path/LICENSE", "MIT"],
  ["virgultum/editor/blocks/surface/src/utils/rough/LICENSE", "MIT"],
  ["virgultum/framework/global/src/gfx/perfect-freehand/LICENSE", "MIT"],
  ["virgultum/icons/THIRD_PARTY_LICENSES.md", "MIT"],
  ["virgultum/provenance/LICENSE-LIT-BSD-3-Clause.txt", "BSD-3-Clause"],
  ["virgultum/provenance/LICENSE-FIGMA-SQUIRCLE-MIT.txt", "MIT"],
  ["virgultum/provenance/LICENSE-GFM-AUTOLINK-MIT.txt", "MIT"],
]);
const LIT_SOURCES = [
  "virgultum/framework/global/src/lit/signal-watcher.ts",
  "virgultum/framework/global/src/lit/watch.ts",
];

function isPublicExportExcluded(path) {
  return path.startsWith("virgultum/icons/dist/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function trackedFiles(repoRoot) {
  if (existsSync(join(repoRoot, ".git"))) {
    return execFileSync("git", ["ls-files", "-z", "virgultum"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .filter((path) => !path.startsWith("virgultum/provenance/"))
      .sort();
  }

  const files = [];
  const stack = [join(repoRoot, "virgultum")];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const path = relative(repoRoot, absolute).replaceAll("\\", "/");
      if (path === "virgultum/provenance") continue;
      if (entry.isDirectory()) stack.push(absolute);
      else files.push(path);
    }
  }
  return files.sort();
}

function licenseNotice(repoRoot, path, { paths, upstreamUrl } = {}) {
  const licenseExpression = EMBEDDED_LICENSES.get(path);
  if (!licenseExpression)
    throw new Error(`${path}: unclassified embedded license`);
  const content = readFileSync(join(repoRoot, path), "utf8");
  const copyrights = content
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Copyright "));
  if (copyrights.length === 0) {
    throw new Error(`${path}: embedded license lacks a copyright line`);
  }
  return {
    path,
    ...(paths ? { paths } : { scope: `${dirname(path)}/**` }),
    origin: "T1",
    licenseExpression,
    copyrightNotices: copyrights.map((copyright) =>
      copyright.replace(/^Copyright (?:\(c\) )?/, ""),
    ),
    sha256: sha256(content),
    ...(upstreamUrl ? { upstreamUrl } : {}),
  };
}

function sourceHeaderLicenses(repoRoot, path) {
  const bytes = readFileSync(join(repoRoot, path));
  if (bytes.includes(0)) return [];
  const licenses = new Set();
  let closing = null;
  for (const line of bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#!") || text.startsWith("<?xml")) continue;
    if (!closing) {
      if (text.startsWith("/*")) closing = "*/";
      else if (text.startsWith("<!--")) closing = "-->";
      else if (!text.startsWith("//") && !text.startsWith("#")) break;
    }
    const match = text.match(
      /SPDX-License-Identifier:\s*(.+?)(?:\s*\*\/|\s*-->)?$/,
    );
    if (match) licenses.add(match[1].trim());
    if (closing && text.includes(closing)) closing = null;
  }
  return [...licenses];
}

export function generateVirgultumProvenance(repoRoot = REPO_ROOT) {
  const files = trackedFiles(repoRoot);
  const publicExportFiles = files.filter(
    (path) => !isPublicExportExcluded(path),
  );
  const packageManifests = files.filter((path) =>
    path.endsWith("/package.json"),
  );
  const packageRoots = packageManifests
    .map((path) => dirname(path))
    .sort((a, b) => b.length - a.length);
  const packageOwner = (path) =>
    packageRoots.find((root) => path.startsWith(`${root}/`));
  const embeddedComponents = files
    .filter(
      (path) =>
        path.endsWith("/LICENSE") ||
        path === "virgultum/icons/THIRD_PARTY_LICENSES.md",
    )
    .map((path) =>
      licenseNotice(
        repoRoot,
        path,
        path === "virgultum/icons/THIRD_PARTY_LICENSES.md"
          ? { paths: [path] }
          : undefined,
      ),
    );
  const litSources = LIT_SOURCES.filter((path) => files.includes(path));
  if (litSources.length > 0) {
    // Keep the BSD text beside the inventory: a directory-level LICENSE in
    // src/lit would incorrectly imply BSD licensing for unrelated siblings.
    embeddedComponents.push(
      licenseNotice(
        repoRoot,
        "virgultum/provenance/LICENSE-LIT-BSD-3-Clause.txt",
        {
          paths: litSources,
          upstreamUrl:
            "https://github.com/lit/lit/blob/16507ef656417c9c53a55a02a44a563bbbf2c484/packages/labs/preact-signals/LICENSE",
        },
      ),
    );
  }
  for (const entry of [
    {
      license: "virgultum/provenance/LICENSE-FIGMA-SQUIRCLE-MIT.txt",
      paths: ["distribute.ts", "draw.ts", "index.ts"].map(
        (name) => `virgultum/editor/shared/src/utils/figma-squircle/${name}`,
      ),
      upstreamUrl:
        "https://github.com/phamfoo/figma-squircle/blob/7239f0aca50ba236d05f3779e89cea4d4b32d8bf/LICENSE",
    },
    {
      license: "virgultum/provenance/LICENSE-GFM-AUTOLINK-MIT.txt",
      paths: ["virgultum/editor/shared/src/adapters/markdown/gfm.ts"],
      upstreamUrl:
        "https://github.com/syntax-tree/mdast-util-gfm-autolink-literal/blob/182000e93a49c259d362e6d3f474b13d35b6472d/license",
    },
  ]) {
    const paths = entry.paths.filter((path) => files.includes(path));
    if (paths.length)
      embeddedComponents.push(
        licenseNotice(repoRoot, entry.license, {
          paths,
          upstreamUrl: entry.upstreamUrl,
        }),
      );
  }
  const sourceInventoryBytes = readFileSync(join(repoRoot, SOURCES));
  const sourceInventory = JSON.parse(sourceInventoryBytes);
  if (sourceInventory.policy.newMyoxusLicense !== "AGPL-3.0-or-later") {
    throw new Error(`${SOURCES}: new Myoxus work must be AGPL`);
  }
  if (sourceInventory.policy.retainedMitFileLicense !== "MIT") {
    throw new Error(
      `${SOURCES}: retained MIT files, including modifications, must remain MIT`,
    );
  }
  const sourceByPath = new Map();
  for (const annotation of sourceInventory.annotations) {
    const { origin, licenseExpression, copyrightNotices } = annotation;
    if (
      !licenseExpression ||
      !copyrightNotices?.length ||
      !["M0", "F1", "F2", "T1", "M0/T1"].includes(origin)
    ) {
      throw new Error(`${SOURCES}: unresolved source classification`);
    }
    if (
      (origin === "M0" && licenseExpression !== "AGPL-3.0-or-later") ||
      (origin === "M0/T1" && !licenseExpression.includes("AGPL-3.0-or-later"))
    ) {
      throw new Error(
        `${SOURCES}: independently new Myoxus files must use AGPL`,
      );
    }
    if (["F1", "F2"].includes(origin) && licenseExpression !== "MIT") {
      throw new Error(
        `${SOURCES}: retained source must use MIT for the whole file`,
      );
    }
    for (const entry of annotation.files) {
      if (sourceByPath.has(entry.path)) {
        throw new Error(`${entry.path}: duplicate source classification`);
      }
      if (!files.includes(entry.path)) {
        if (isPublicExportExcluded(entry.path)) continue;
        throw new Error(`${entry.path}: stale source classification`);
      }
      if (
        ["F1", "F2"].includes(origin) &&
        (!entry.originalPath || !/^[a-f0-9]{40}$/.test(entry.originalGitBlob))
      ) {
        throw new Error(
          `${entry.path}: retained source lacks pinned original evidence`,
        );
      }
      if (sha256(readFileSync(join(repoRoot, entry.path))) !== entry.sha256) {
        throw new Error(
          `${entry.path}: source changed; review origin/license before updating its fingerprint`,
        );
      }
      if (origin === "T1") {
        const original = embeddedComponents.find(
          (component) =>
            component.paths?.includes(entry.path) ||
            (component.scope &&
              entry.path.startsWith(component.scope.slice(0, -2))),
        );
        if (!original || licenseExpression !== original.licenseExpression) {
          throw new Error(
            `${entry.path}: retained third-party file must keep its original license`,
          );
        }
      }
      const headers = sourceHeaderLicenses(repoRoot, entry.path);
      const grants = licenseExpression.split(" AND ");
      if (
        headers.some((header) =>
          header.split(" AND ").some((grant) => !grants.includes(grant)),
        )
      ) {
        throw new Error(
          `${entry.path}: SPDX header contradicts reviewed source licenses`,
        );
      }
      sourceByPath.set(entry.path, {
        origin,
        licenseExpression,
        copyrightNotices,
      });
    }
  }
  for (const path of files) {
    if (!sourceByPath.has(path))
      throw new Error(`${path}: unclassified source path`);
  }
  const aggregate = (paths) => {
    const entries = paths.map((path) => sourceByPath.get(path));
    return {
      origin: [...new Set(entries.flatMap((entry) => entry.origin.split("/")))]
        .sort()
        .join("/"),
      licenseExpression: [
        ...new Set(
          entries.flatMap((entry) => entry.licenseExpression.split(" AND ")),
        ),
      ]
        .sort()
        .join(" AND "),
      copyrightNotices: [
        ...new Set(entries.flatMap((entry) => entry.copyrightNotices)),
      ].sort(),
    };
  };
  const packages = packageManifests.map((manifestPath) => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, manifestPath), "utf8"),
    );
    if (!manifest.name || !manifest.license) {
      throw new Error(
        `${manifestPath}: name and license metadata are required`,
      );
    }
    // Package metadata summarizes separate files. The reviewed inventory,
    // never the package label, determines each file's source license.
    return {
      manifest: manifestPath,
      path: `${dirname(manifestPath)}/**`,
      packageName: manifest.name,
      declaredPackageLicense: manifest.license,
      ...aggregate(
        files.filter((path) => packageOwner(path) === dirname(manifestPath)),
      ),
    };
  });

  const unowned = files.filter(
    (path) =>
      !ROOT_FILES.includes(path) &&
      !packageRoots.some(
        (root) => path === root || path.startsWith(`${root}/`),
      ),
  );
  if (unowned.length > 0) {
    throw new Error(
      `unclassified tracked Virgultum paths:\n${unowned.join("\n")}`,
    );
  }
  for (const path of ROOT_FILES) {
    if (!files.includes(path)) {
      throw new Error(`required root classification path is missing: ${path}`);
    }
  }

  const licenseCounts = Object.fromEntries(
    [...new Set(packages.map((entry) => entry.declaredPackageLicense))]
      .sort()
      .map((license) => [
        license,
        packages.filter((entry) => entry.declaredPackageLicense === license)
          .length,
      ]),
  );

  return {
    schemaVersion: 1,
    generatedFrom: {
      generator: GENERATOR,
      sourceInventory: { path: SOURCES, sha256: sha256(sourceInventoryBytes) },
      trackedPathCount: files.length,
      trackedPathSha256: sha256(`${files.join("\n")}\n`),
      publicExport: {
        excludedPaths: PUBLIC_EXPORT_EXCLUDED_PATHS,
        trackedPathCount: publicExportFiles.length,
        trackedPathSha256: sha256(`${publicExportFiles.join("\n")}\n`),
      },
      packageManifestCount: packages.length,
      packageLicenseCounts: licenseCounts,
    },
    policy: {
      upstreamCutoff: {
        revision: CUTOFF_REVISION,
        date: "2026-03-04",
      },
      upstreamMitLicense: "client/provenance/LICENSE-UPSTREAM-MIT.txt",
      mplLicense: {
        path: "virgultum/provenance/LICENSE-MPL-2.0.txt",
        sha256: sha256(
          readFileSync(
            join(repoRoot, "virgultum/provenance/LICENSE-MPL-2.0.txt"),
          ),
        ),
      },
      myoxusLicense: "LICENSE",
      unresolvedOriginAllowed: false,
    },
    rootFiles: {
      paths: ROOT_FILES,
      ...aggregate(ROOT_FILES),
    },
    packages,
    embeddedComponents,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputPath = join(REPO_ROOT, OUTPUT);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${JSON.stringify(generateVirgultumProvenance(), null, 2)}\n`,
  );
  console.log(`Wrote ${OUTPUT}`);
}
