// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyReleaseMetadata } from "./verify-desktop-release-metadata.mjs";

/** Render only verified regular Mac metadata; generation never publishes a tap. */
export function renderHomebrewCask(manifest, { github = false } = {}) {
  if (!manifest.publishable || !["macos", "full"].includes(manifest.scope)) {
    throw new Error(
      "Homebrew requires a complete publishable macOS platform set",
    );
  }
  const { channel, version } = manifest;
  if (
    !/^(stable|beta|internal)$/.test(channel) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
    (channel === "stable"
      ? version.includes("-")
      : version.split("-")[1]?.split(".")[0] !== channel)
  ) {
    throw new Error("Invalid Homebrew version/channel identity");
  }
  const token = channel === "stable" ? "myoxus" : `myoxus-${channel}`;
  const app = channel === "stable" ? "Myoxus" : `Myoxus-${channel}`;
  const tag = `${manifest.scope === "macos" ? "macos-client" : "desktop"}-v${version}`;
  const dmg = (arch) => {
    const matches = manifest.artifacts.filter(
      (a) => a.platform === "macos" && a.arch === arch && a.format === "dmg",
    );
    if (
      matches.length !== 1 ||
      matches[0].name !== `myoxus-${version}-${channel}-macos-${arch}.dmg` ||
      !/^[a-f0-9]{64}$/.test(matches[0].sha256)
    ) {
      throw new Error(`Missing canonical ${arch} DMG identity/digest`);
    }
    return matches[0];
  };
  const arm = dmg("arm64"),
    intel = dmg("x64");
  const downloads = github
    ? "https://github.com/superions/myoxus"
    : "https://git.blume29.de/myoxus/packages";
  return {
    token,
    version,
    path: `Casks/${token}.rb`,
    source: [
      `cask "${token}" do`,
      '  arch arm: "arm64", intel: "x64"',
      "",
      `  version "${version}"`,
      `  sha256 arm: "${arm.sha256}",`,
      `         intel: "${intel.sha256}"`,
      "",
      `  url "${downloads}/releases/download/${tag}/myoxus-${version}-${channel}-macos-#{arch}.dmg"`,
      `  name "${app}"`,
      '  desc "Collaborative workspace"',
      '  homepage "https://github.com/superions/myoxus"',
      "",
      "  depends_on :macos",
      "",
      `  app "${app}.app"`,
      "end",
      "",
    ].join("\n"),
  };
}

export function writeHomebrewCask(releaseDir, outputDir) {
  const cask = renderHomebrewCask(
    verifyReleaseMetadata(path.resolve(releaseDir), true),
  );
  const destination = path.join(outputDir, cask.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, cask.source);
  return cask;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 4)
    throw new Error(
      "Usage: write-homebrew-cask.mjs <verified-release-directory> <output-directory>",
    );
  const cask = writeHomebrewCask(process.argv[2], process.argv[3]);
  console.log(
    `Generated ${cask.path} for ${cask.version}; no tap was published`,
  );
}
