// SPDX-License-Identifier: MIT

import { chmod, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";

import type {
  ElectronTargetArch,
  ElectronTargetPlatform,
} from "./build-context";

type PackagerTargetPlatform = ElectronTargetPlatform | "mas";

export async function ensureLinuxPackageRootPermissions(
  packagedPath: string,
  targetPlatform: PackagerTargetPlatform,
): Promise<void> {
  if (targetPlatform === "linux") {
    await chmod(packagedPath, 0o755);
  }
}

const defaultLocales = new Set([
  "en",
  "en_US",
  "en_GB",
  "zh_CN",
  "zh_TW",
  "fr",
  "es",
  "es_419",
  "pl",
  "de",
  "ru",
  "ja",
  "it",
  "ca",
  "da",
  "hi",
  "sv",
  "ur",
  "ar",
  "uk",
  "ko",
  "pt_BR",
  "fa",
  "nb",
]);

function localesToKeep(
  environment: NodeJS.ProcessEnv = process.env,
): Set<string> | null {
  const raw = environment.ELECTRON_LOCALES_KEEP?.trim();
  if (!raw) return defaultLocales;
  if (["all", "*"].includes(raw.toLowerCase())) return null;

  const keep = new Set(
    raw
      .split(",")
      .map((locale) => locale.trim())
      .filter(Boolean),
  );
  keep.add("en");
  keep.add("en_US");
  keep.add("en_GB");
  return keep;
}

function pakLocalesToKeep(locales: Set<string>): Set<string> {
  const keep = new Set(["en", "en-US", "en-GB"]);
  for (const locale of locales) {
    keep.add(locale === "en" ? "en-US" : locale.replaceAll("_", "-"));
  }
  return keep;
}

export async function trimElectronLocales(
  resourcesAppDir: string,
  targetPlatform: PackagerTargetPlatform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (environment.TRIM_ELECTRON_LOCALES === "0") return;
  const keep = localesToKeep(environment);
  if (!keep) return;

  if (["darwin", "mas"].includes(targetPlatform)) {
    const frameworkResources = path.join(
      path.resolve(resourcesAppDir, "..", ".."),
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Resources",
    );
    const entries = await readdir(frameworkResources, {
      withFileTypes: true,
    }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(".lproj"))
        .filter((entry) => !keep.has(entry.name.slice(0, -".lproj".length)))
        .map((entry) =>
          rm(path.join(frameworkResources, entry.name), {
            recursive: true,
            force: true,
          }),
        ),
    );
    return;
  }

  if (!["linux", "win32"].includes(targetPlatform)) return;
  const localesDirectory = path.join(
    path.resolve(resourcesAppDir, "..", ".."),
    "locales",
  );
  const pakKeep = pakLocalesToKeep(keep);
  const entries = await readdir(localesDirectory, {
    withFileTypes: true,
  }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".pak"))
      .filter(
        (entry) => !pakKeep.has(entry.name.slice(0, -".pak".length)),
      )
      .map((entry) => rm(path.join(localesDirectory, entry.name), { force: true })),
  );
}

function fuseOptions({
  resetAdHocDarwinSignature,
}: {
  resetAdHocDarwinSignature: boolean;
}) {
  return {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]:
      process.env.ELECTRON_E2E === "1",
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    resetAdHocDarwinSignature,
  };
}

export async function applyElectronFusesToBuildPath({
  buildPath,
  hasOsxSignConfig,
  targetArch,
  targetPlatform,
}: {
  buildPath: string;
  hasOsxSignConfig: boolean;
  targetArch: ElectronTargetArch;
  targetPlatform: PackagerTargetPlatform;
}): Promise<void> {
  const applePlatform = ["darwin", "mas"].includes(targetPlatform);
  const executable = path.join(
    path.resolve(buildPath, "..", ".."),
    applePlatform ? "MacOS" : "",
    applePlatform ? "Electron" : targetPlatform === "win32" ? "electron.exe" : "electron",
  );
  await flipFuses(
    executable,
    fuseOptions({
      resetAdHocDarwinSignature:
        !hasOsxSignConfig && applePlatform && targetArch === "arm64",
    }),
  );
}
