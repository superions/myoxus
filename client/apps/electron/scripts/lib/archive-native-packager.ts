// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BuildContext } from "./build-context";
import type { PackagingIdentity } from "./packaging-config";
import { runProcess } from "./process";

/** Preserve the deployed DMG volume label, including the non-default architecture. */
export function macosVolumeName(identity: PackagingIdentity): string {
  return `${identity.productName} ${identity.version}${identity.arch === "arm64" ? "-arm64" : ""}`;
}

export async function buildDesktopArchives({
  application,
  outputDirectory,
  context,
  identity,
}: {
  application: string;
  outputDirectory: string;
  context: BuildContext;
  identity: PackagingIdentity;
}): Promise<string[]> {
  const zip = path.join(outputDirectory, identity.artifactName("zip"));
  const run = (command: string, args: string[]) =>
    runProcess({ command, args, cwd: outputDirectory, timeoutMs: 600_000 });
  if (context.platform === "win32") {
    // Windows' libarchive tar retains the application at the archive root,
    // including hidden files that Compress-Archive silently omits.
    await run("tar.exe", ["-a", "-cf", zip, "-C", application, "."]);
    return [zip];
  }
  if (context.platform !== "darwin")
    throw new Error("Archive packaging requires macOS or Windows");
  // ditto preserves signed bundle symlinks, resource forks and the .app root.
  await run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    application,
    zip,
  ]);
  const dmg = path.join(outputDirectory, identity.artifactName("dmg"));
  const tools = path.join(context.outDir, "packaging-tools");
  await mkdir(tools, { recursive: true });
  await run("bash", [
    path.join(context.repoRoot, "build/scripts/ci/ensure-dmg-tool.sh"),
    tools,
  ]);
  const settings = path.join(
    path.dirname(outputDirectory),
    "dmg-settings.json",
  );
  await writeFile(
    settings,
    JSON.stringify({
      format: "ULFO",
      files: [application],
      symlinks: { Applications: "/Applications" },
      icon: identity.macosIcns,
      background: path.join(
        context.stageAppDir,
        "resources/icons/dmg-background.png",
      ),
      icon_locations: {
        [path.basename(application)]: [176, 192],
        Applications: [432, 192],
      },
      icon_size: 118,
      text_size: 12,
      window_rect: [
        [400, 538],
        [610, 365],
      ],
      default_view: "icon-view",
      show_toolbar: false,
      show_status_bar: false,
      show_sidebar: false,
    }),
  );
  // dmgbuild's JSON input is an appdmg compatibility dialect. Load our own
  // typed settings through its native Python interface instead.
  const loader = path.join(path.dirname(outputDirectory), "dmg-settings.py");
  await writeFile(
    loader,
    `import json\nwith open(${JSON.stringify(settings)}, encoding="utf-8") as source:\n    globals().update(json.load(source))\n`,
  );
  await run(path.join(tools, "dmg/bin/dmgbuild"), [
    "-s",
    loader,
    macosVolumeName(identity),
    dmg,
  ]);
  await run("hdiutil", ["verify", dmg]);
  return [dmg, zip];
}
