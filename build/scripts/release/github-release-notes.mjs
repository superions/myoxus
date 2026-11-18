// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { githubContainerLine } from "./github-container-registry.mjs";

export function renderContainerReleaseNotes({
  version,
  tag,
  prerelease,
  notes,
  source,
  containers,
  assets,
}) {
  const publicRepo = "https://github.com/superions/myoxus";
  const raw = `https://raw.githubusercontent.com/superions/myoxus/${source.commit}`;
  const assetUrl = (name) =>
    `${publicRepo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const packages = assets.flatMap(({ name }) => {
    if (name.endsWith(".deb")) return [`[DEB for Ubuntu](${assetUrl(name)})`];
    if (name.endsWith(".rpm")) return [`[RPM for Fedora](${assetUrl(name)})`];
    return [];
  });
  const bundle = `myoxus-${version}-legal-provenance.tar.gz`;

  return [
    '<p align="center">',
    `  <img src="${raw}/assets/branding/myoxus_text.svg" width="320" alt="Myoxus" /><br />`,
    `  <img src="${raw}/client/branding/artwork/docs-hero.webp" width="480" alt="The Myoxus dormouse among documents, folders, and a database" />`,
    "</p>",
    "",
    `## Myoxus ${version}${prerelease ? " · Beta" : ""}`,
    "",
    "### What’s new",
    "",
    notes.trim(),
    "",
    "### Install or upgrade",
    "",
    `<img align="right" src="${raw}/client/branding/artwork/guide-start.webp" width="155" alt="The Myoxus dormouse with a compass and checklist" />`,
    "",
    "| Install method | Start here |",
    "| --- | --- |",
    `| **Containers** | [Self-hosting guide](${publicRepo}/blob/${source.commit}/docs/ops/deployment/docker.md) |`,
    ...(packages.length
      ? [`| **Native Linux · x86_64** | ${packages.join(" · ")} |`]
      : []),
    "",
    "### Container images",
    "",
    `Server, Web, and Admin are available from GitHub Container Registry under the \`${version}\` tag. Pin the verified digests below for reproducible deployments.`,
    "",
    ...containers.map(githubContainerLine),
    "",
    "<details>",
    "<summary>Source, checksums, and build provenance</summary>",
    "",
    `- [Matching source](${source.repository}/tree/${source.commit}) · [Source archive](${source.repository}/archive/${source.commit}.tar.gz)`,
    `- Source tree \`${source.tree}\``,
    `- [Release asset checksums](${assetUrl("GITHUB-SHA256SUMS")})`,
    `- [License notices, SBOMs, and provenance](${assetUrl(bundle)})`,
    "",
    "</details>",
    "",
  ].join("\n");
}
