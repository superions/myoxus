#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  readSourceProvenance,
  validateSourceArchive,
} from "./source-correspondence.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const repoRoot = args.get("--repo-root");
const output = args.get("--output");
const revision = args.get("--revision");
const version = args.get("--version");
const epoch = Number(args.get("--epoch"));
if (!repoRoot || !output || !version || !Number.isSafeInteger(epoch)) {
  throw new Error("Missing legal-bundle argument");
}
if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revision ?? "")) {
  throw new Error("Legal bundle requires a full Git revision");
}

// A build revision identifies the input tree; it is not a public repository
// revision. Only the publication owner may supply a corresponding-source URL.
const archiveUrl = args.get("--source-archive-url") ?? "";
const archiveSha256 = args.get("--source-archive-sha256") ?? "";
const suppliedArchive = validateSourceArchive(archiveUrl, archiveSha256);
const publicSource = readSourceProvenance(
  args.get("--source-provenance"),
  revision,
);
if (
  suppliedArchive &&
  publicSource &&
  (suppliedArchive.url !== publicSource.archive?.url ||
    suppliedArchive.sha256 !== publicSource.archive?.sha256)
) {
  throw new Error(
    "Explicit source archive disagrees with public source provenance",
  );
}
const correspondingArchive = publicSource?.archive ?? suppliedArchive;

const componentsSource = await readFile(
  path.join(repoRoot, "server/provenance/components.json"),
  "utf8",
);
const components = JSON.parse(componentsSource);
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      path.join(repoRoot, "server/Cargo.toml"),
      "--format-version=1",
      "--locked",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ),
);

const cargoPackages = metadata.packages
  // Vendored patches have no registry source but retain third-party licenses.
  .filter(
    (pkg) =>
      pkg.source !== null ||
      pkg.manifest_path.startsWith(path.join(repoRoot, "vendor") + path.sep),
  )
  .map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    license:
      pkg.license ??
      `SEE-LICENSE-FILE: ${pkg.license_file ? path.basename(pkg.license_file) : "unspecified"}`,
    source: pkg.repository ?? pkg.homepage ?? pkg.source,
  }))
  .sort((left, right) =>
    `${left.name}\0${left.version}`.localeCompare(
      `${right.name}\0${right.version}`,
    ),
  );

const componentRows = components.components.flatMap((component) =>
  component.paths.map((componentPath, index) => ({
    id: component.id,
    path: componentPath,
    license: component.licenseExpression,
    upstream: component.upstreamUrl,
    revision: component.upstreamRevision,
    sha256: component.sha256[index],
    notices: component.noticePaths.join(", "),
  })),
);

const notices = `# Myoxus Server Third-Party Notices

This generated inventory complements, but does not replace, the license and
notice files shipped beside runtime assets. Cargo entries come from the locked
server workspace graph; bundled assets come from
\`server/provenance/components.json\`.

## Bundled runtime components

| Component | Path | License | Upstream revision | SHA-256 | Notice |
| --- | --- | --- | --- | --- | --- |
${componentRows
  .map(
    (row) =>
      `| ${row.id} | \`${row.path}\` | ${row.license} | [\`${row.revision}\`](${row.upstream}) | \`${row.sha256}\` | ${row.notices
        .split(", ")
        .map((item) => `\`${item}\``)
        .join(", ")} |`,
  )
  .join("\n")}

## Locked Cargo packages

| Package | Version | License expression or license file | Source |
| --- | --- | --- | --- |
${cargoPackages.map((pkg) => `| ${pkg.name.replaceAll("|", "\\|")} | ${pkg.version} | ${pkg.license.replaceAll("|", "\\|")} | ${pkg.source ? `[upstream](${pkg.source})` : "Cargo.lock"} |`).join("\n")}
`;

const timestamp = new Date(epoch * 1000).toISOString();
const source = `# Myoxus Server Source Correspondence

## Build identity

- Git revision: \`${revision}\`
- Server version: \`${version}\`
- Reproducible build timestamp: \`${timestamp}\` (\`SOURCE_DATE_EPOCH=${epoch}\`)

The Git revision identifies the build input. It does not imply that this commit
or its history is published in the public repository. Internal build records
retain the mapping between build inputs and released artifacts.

## Corresponding source

${
  publicSource?.tree && !correspondingArchive
    ? `- Public source commit: <${publicSource.repository}/tree/${publicSource.commit}>\n- Public source tree: \`${publicSource.tree}\`\n- Source download: <${publicSource.repository}/archive/${publicSource.commit}.tar.gz>\n\nThe Git commit and tree identify the qualified source. GitHub-generated archive\ncompression may change; no permanent compressed-archive digest is claimed.`
    : correspondingArchive
    ? `${publicSource ? `- Public source commit: <${publicSource.repository}/tree/${publicSource.commit}>\n` : ""}- Source archive: <${correspondingArchive.url}>\n- Source archive SHA-256: \`${correspondingArchive.sha256}\`\n\nVerify the downloaded archive against this digest. The release publisher is\nresponsible for verifying that it contains the corresponding source for this build.`
    : `No public source archive is configured for this build. This document does not\nclaim public source availability. Before public distribution, the release\npublisher must provide and verify the corresponding source.`
}
`;

await mkdir(path.join(output, "provenance"), { recursive: true });
await mkdir(path.join(output, "sbom"), { recursive: true });
await writeFile(path.join(output, "THIRD_PARTY_NOTICES.md"), notices);
await writeFile(path.join(output, "SOURCE.md"), source);
await writeFile(
  path.join(output, "provenance/components.json"),
  componentsSource,
);

const yrs = metadata.packages.find((pkg) => pkg.name === "myoxus-yrs");
if (!yrs || yrs.license !== "MIT") {
  throw new Error("Locked myoxus-yrs MIT license owner is missing");
}
await mkdir(path.join(output, "licenses/myoxus-yrs"), { recursive: true });
await writeFile(
  path.join(output, "licenses/myoxus-yrs/LICENSE"),
  await readFile(path.join(path.dirname(yrs.manifest_path), "LICENSE")),
);

// Each resolved fork package owns its complete grant and provenance; a shared
// local license would hide missing or mismatched material in published archives.
const mitGrant =
  `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`.replace(/\s+/g, " ");
for (const pkg of metadata.packages.filter((candidate) =>
  candidate.name.startsWith("glirulus-"),
)) {
  if (
    pkg.license !== "MIT" ||
    pkg.source !== "registry+https://github.com/rust-lang/crates.io-index" ||
    pkg.repository !== "https://github.com/superions/glirulus"
  ) {
    throw new Error(`Unexpected Glirulus license owner: ${pkg.name}`);
  }
  const directory = path.dirname(pkg.manifest_path);
  const license = await readFile(path.join(directory, "LICENSE"));
  const notice = await readFile(path.join(directory, "NOTICE"));
  const licenseText = license.toString("utf8");
  const noticeText = notice.toString("utf8");
  const authors = [
    "Copyright (c) 2026 Sayiir",
    "Copyright (c) 2026 Daniel Scharf",
  ];
  if (
    !licenseText.replace(/\s+/g, " ").includes(mitGrant) ||
    !authors.every((author) => licenseText.includes(author)) ||
    !authors.every((author) => noticeText.includes(author)) ||
    !noticeText.includes("Glirulus") ||
    !noticeText.includes("MIT") ||
    !noticeText.includes(pkg.name.replace("glirulus-", "sayiir-")) ||
    !noticeText.includes("https://github.com/sayiir/sayiir")
  ) {
    throw new Error(
      `Incomplete Glirulus MIT grant or source notice: ${pkg.name}`,
    );
  }
  const destination = path.join(output, "licenses", pkg.name);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "LICENSE"), license);
  await writeFile(path.join(destination, "NOTICE"), notice);
}

const patchesSource = await readFile(
  path.join(repoRoot, "build/dependencies/paste-consumers-source.json"),
  "utf8",
);
const patches = JSON.parse(patchesSource);
// Local Cargo patches are still third-party code. Package their actual notices
// with the image/deb, rather than relying only on the inventory's SPDX expression.
for (const name of ["biblatex", "hayagriva", "safer-bytes", "simba"]) {
  const pkg = metadata.packages.find((candidate) => candidate.name === name);
  if (!pkg || pkg.version !== patches[name].version) {
    throw new Error(`Vendored license owner does not match Cargo: ${name}`);
  }
  const licenses = Object.keys(patches[name].files).filter((file) =>
    /^(LICENSE(?:[-.].*)?|NOTICE)$/.test(file),
  );
  const destination = path.join(output, "licenses", name);
  await mkdir(destination, { recursive: true });
  for (const file of licenses) {
    await writeFile(
      path.join(destination, file),
      await readFile(path.join(repoRoot, "vendor/cargo", name, file)),
    );
  }
  if (name === "safer-bytes") {
    await writeFile(
      path.join(destination, "DECLARED-MIT.txt"),
      await readFile(
        path.join(repoRoot, "build/dependencies/safer-bytes-license.txt"),
      ),
    );
  } else if (licenses.length === 0) {
    throw new Error(`Missing published license/notice files: ${name}`);
  }
}
await writeFile(
  path.join(output, "provenance/paste-consumers-source.json"),
  patchesSource,
);
