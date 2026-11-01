#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_PROJECT_URLS } from "../../../tools/utils/src/public-urls.ts";

const projectRepository = PUBLIC_PROJECT_URLS.repository;
const urlPattern = /https?:\/\/[^\s"'`<>\\)\]]+/g;
const ignoredDirectories = new Set([
  ".git",
  ".yarn",
  "dist",
  "node_modules",
  "target",
]);
const ignoredExtensions = new Set([
  ".avif",
  ".bin",
  ".gif",
  ".ico",
  ".icns",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".png",
  ".ttf",
  ".woff",
  ".woff2",
  ".zip",
]);
const requiredOwnerFragments = new Map([
  [
    "client/apps/electron/package.json",
    [`"url": "${projectRepository}"`, `"homepage": "${projectRepository}"`],
  ],
  ["client/libs/i18n/package.json", [`"url": "git+${projectRepository}.git"`]],
  [
    "build/server/Dockerfile",
    [`org.opencontainers.image.source="${projectRepository}"`],
  ],
  [
    "build/web/Dockerfile",
    [`org.opencontainers.image.source="${projectRepository}"`],
  ],
  [
    "build/web/Dockerfile.prebuilt",
    [`org.opencontainers.image.source="${projectRepository}"`],
  ],
  [
    "build/admin/Dockerfile",
    [`org.opencontainers.image.source="${projectRepository}"`],
  ],
  [
    "build/admin/Dockerfile.prebuilt",
    [`org.opencontainers.image.source="${projectRepository}"`],
  ],
  [
    "build/scripts/frontends/materialize-static-artifacts.sh",
    [`OCI_SOURCE="${projectRepository}"`],
  ],
  [
    "build/scripts/ci/verify-built-release-identity.mjs",
    [`const OCI_SOURCE = "${projectRepository}";`],
  ],
]);

function filesBelow(root, relative = "") {
  const directory = path.join(root, relative);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : filesBelow(root, next);
    }
    return entry.isFile() ? [next] : [];
  });
}

function sourceFiles(root) {
  // Repository checks must follow Git ignores, not scan stale generated bundles.
  // Exported source archives have no Git metadata and still need a full tree scan.
  if (!existsSync(path.join(root, ".git"))) return filesBelow(root);
  return execFileSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(
      (file) =>
        file && !file.split("/").some((part) => ignoredDirectories.has(part)),
    )
    .filter(
      (file) =>
        existsSync(path.join(root, file)) &&
        lstatSync(path.join(root, file)).isFile(),
    );
}

function isCanonicalForgejoOwner(file) {
  return (
    file.startsWith(".forgejo/") ||
    file.startsWith(".agents/") ||
    file.startsWith("build/") ||
    file.startsWith("docs/dev/") ||
    file.startsWith("docs/ops/") ||
    file === "client/apps/electron/src/main/updater/update-manifest.ts" ||
    file === "client/apps/electron/test/main/updater.spec.ts"
  );
}

export function classifyPublicUrl(file, url) {
  if (file === "build/scripts/ci/verify-public-url-ownership.mjs") {
    return "url-policy-negative-fixture";
  }
  if (
    file === "build/scripts/ci/verify-active-path-contracts.mjs" &&
    /affine|toeverything|getaffineapp/i.test(url)
  ) {
    return "identity-policy-negative-fixture";
  }
  if (url.startsWith(projectRepository)) {
    if (/\/commit\/[0-9a-f]{40}$/i.test(url)) {
      return "private-revision-public-link";
    }
    return "project-public-navigation";
  }
  // The downloads page owns the two current distribution destinations;
  // this does not permit arbitrary Forgejo links in product navigation.
  if (
    file === "docs/user/downloads.md" &&
    [
      "https://git.blume29.de/myoxus/packages/src/branch/main/DISTRIBUTION.md",
      "https://git.blume29.de/myoxus/packages/releases",
    ].includes(url)
  )
    return "canonical-forgejo-operation";
  if (
    url.startsWith("https://git.blume29.de/") ||
    url.startsWith("https://data.forgejo.org/")
  ) {
    return isCanonicalForgejoOwner(file)
      ? "canonical-forgejo-operation"
      : "unowned-forgejo-reference";
  }
  if (
    /^https?:\/\/(?:[^/]+\.)?myoxus\.(?:de|org)(?:[/:]|$)/i.test(url) &&
    /(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)/.test(file)
  ) {
    return "historical-or-test-example";
  }
  if (/^https?:\/\/(?:[^/]+\.)?myoxus\.(?:de|org)(?:[/:]|$)/i.test(url)) {
    return "stale-project-host";
  }
  if (/^https?:\/\/[^/]*\.example(?:\.com)?(?:[/:]|$)/i.test(url)) {
    return "deployment-or-test-example";
  }
  if (url.startsWith("https://github.com/")) {
    return "third-party-source-or-integration";
  }
  if (/affine|toeverything|getaffineapp/i.test(url)) {
    return /(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)/.test(file)
      ? "historical-protocol-fixture"
      : "unowned-affine-reference";
  }
  return "external-service-or-example";
}

export function verifyPublicUrlOwnership(root) {
  const findings = [];
  if (
    existsSync(
      path.join(root, "build/scripts/ci/verify-public-url-ownership.mjs"),
    )
  ) {
    for (const [file, fragments] of requiredOwnerFragments) {
      const absolute = path.join(root, file);
      if (!existsSync(absolute)) {
        findings.push(`${file}: required public URL consumer is missing`);
        continue;
      }
      const source = readFileSync(absolute, "utf8");
      for (const fragment of fragments) {
        if (!source.includes(fragment)) {
          findings.push(`${file}: public URL owner projection is stale`);
        }
      }
    }
  }
  for (const file of sourceFiles(root)) {
    if (
      file.startsWith(".agents/") ||
      file.startsWith(".codex/") ||
      file.startsWith(".forgejo/") ||
      file.startsWith(".private/") ||
      file.startsWith("docs/dev/") ||
      file.startsWith("docs/test/") ||
      file.startsWith("learnings/") ||
      file.startsWith("todo/")
    ) {
      continue;
    }
    if (ignoredExtensions.has(path.extname(file).toLowerCase())) continue;
    const absolute = path.join(root, file);
    if (statSync(absolute).size > 5_000_000) continue;
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const source = bytes.toString("utf8");
    for (const url of source.match(urlPattern) ?? []) {
      const classification = classifyPublicUrl(file, url);
      if (
        classification === "stale-project-host" ||
        classification === "unowned-forgejo-reference" ||
        classification === "unowned-affine-reference" ||
        classification === "private-revision-public-link"
      ) {
        findings.push(`${file}: ${classification}: ${url}`);
      }
    }
    if (
      /(?:href|url|homepage|repository)[^\n]*(?:docs\/dev|docs\/test|todo\/|learnings\/)/i.test(
        source,
      ) &&
      !file.startsWith("docs/dev/") &&
      !file.startsWith("docs/test/")
    ) {
      findings.push(
        `${file}: public consumer links to excluded internal material`,
      );
    }
  }
  return findings;
}

function selfTest() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "myoxus-url-owner-"));
  try {
    execFileSync("git", ["init", "--quiet", fixtureRoot]);
    writeFileSync(path.join(fixtureRoot, ".gitignore"), "generated.map\n");
    execFileSync("git", ["-C", fixtureRoot, "add", ".gitignore"]);
    // An ignored file must not mask a real finding in an untracked source file.
    writeFileSync(
      path.join(fixtureRoot, "generated.map"),
      'homepage: "https://docs.myoxus.org/"',
    );
    assert.deepEqual(verifyPublicUrlOwnership(fixtureRoot), []);
    writeFileSync(
      path.join(fixtureRoot, "app.ts"),
      'homepage: "https://docs.myoxus.org/"',
    );
    assert.equal(verifyPublicUrlOwnership(fixtureRoot).length, 1);
    rmSync(path.join(fixtureRoot, ".git"), { recursive: true });
    assert.equal(
      verifyPublicUrlOwnership(fixtureRoot).length,
      2,
      "source exports remain fully checked",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  assert.equal(
    classifyPublicUrl("client/app.ts", PUBLIC_PROJECT_URLS.documentation),
    "project-public-navigation",
  );
  assert.equal(
    classifyPublicUrl(
      "build/scripts/release/release.sh",
      "https://git.blume29.de/myoxus/myoxus",
    ),
    "canonical-forgejo-operation",
  );
  assert.equal(
    classifyPublicUrl("client/app.ts", "https://git.blume29.de/myoxus/myoxus"),
    "unowned-forgejo-reference",
  );
  assert.equal(
    classifyPublicUrl("client/app.ts", "https://docs.myoxus.org/"),
    "stale-project-host",
  );
  assert.equal(
    classifyPublicUrl(
      "server/Cargo.toml",
      "https://github.com/typst/citationberg.git",
    ),
    "third-party-source-or-integration",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  const root = path.resolve(
    process.argv[process.argv.indexOf("--root") + 1] ??
      fileURLToPath(new URL("../../..", import.meta.url)),
  );
  const findings = verifyPublicUrlOwnership(root);
  if (findings.length > 0) {
    process.stderr.write(`${findings.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("public URL ownership verified\n");
  }
}
