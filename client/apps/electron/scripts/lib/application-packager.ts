// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs/promises";
import path from "node:path";

import {
  packager as runElectronPackager,
  type Options as ElectronPackagerOptions,
} from "@electron/packager";

import type { BuildContext } from "./build-context";
import { pathExists, readJsonFile } from "./native-files";
import {
  assertPackagedLayout,
  replaceDirectoryAtomically,
} from "./package-layout";
import {
  applyElectronFusesToBuildPath,
  ensureLinuxPackageRootPermissions,
  trimElectronLocales,
} from "./package-postprocess";
import { createApplicationPackagerValues } from "./packaging-config";
import { runProcess } from "./process";

type ElectronPackager = typeof runElectronPackager;

export function assertPackagingHost(
  target: Pick<BuildContext, "platform" | "arch">,
  host: { platform: string; arch: string } = process,
): void {
  const appleCrossBuild =
    target.platform === "darwin" &&
    host.platform === "darwin" &&
    ["x64", "arm64"].includes(host.arch);
  if (
    host.platform !== target.platform ||
    (host.arch !== target.arch && !appleCrossBuild)
  ) {
    throw new Error(
      `Electron application packaging requires its owning ${target.platform}/${target.arch} host or a macOS cross-build host; current host is ${host.platform}/${host.arch}`,
    );
  }
}

export function applePackagingOptions(
  environment: NodeJS.ProcessEnv,
): Pick<ElectronPackagerOptions, "osxNotarize" | "osxSign"> {
  const identity = environment.APPLE_SIGNING_IDENTITY?.trim();
  const appleId = environment.APPLE_ID?.trim();
  const appleIdPassword = environment.APPLE_PASSWORD?.trim();
  const teamId = environment.APPLE_TEAM_ID?.trim();
  const notarizationValues = [appleId, appleIdPassword, teamId];
  const hasNotarizationValue = notarizationValues.some(Boolean);
  const hasCompleteNotarization = notarizationValues.every(Boolean);

  if (hasNotarizationValue && !hasCompleteNotarization) {
    throw new Error(
      "macOS notarization requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID",
    );
  }
  if (hasCompleteNotarization && !identity) {
    throw new Error("macOS notarization requires APPLE_SIGNING_IDENTITY");
  }

  return {
    osxSign: identity
      ? {
          identity,
          optionsForFile: () => ({ hardenedRuntime: true }),
        }
      : undefined,
    osxNotarize:
      identity && appleId && appleIdPassword && teamId
        ? {
            appleId,
            appleIdPassword,
            teamId,
          }
        : undefined,
  };
}

async function adHocSignDarwinApplication({
  appPath,
  context,
  environment,
}: {
  appPath: string;
  context: BuildContext;
  environment: NodeJS.ProcessEnv;
}): Promise<void> {
  if (
    context.platform !== "darwin" ||
    process.platform !== "darwin" ||
    environment.APPLE_SIGNING_IDENTITY?.trim()
  ) {
    return;
  }
  for (const args of [
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  ]) {
    await runProcess({ command: "codesign", args, cwd: context.repoRoot });
  }
}

export async function packageElectronApplication({
  context,
  environment = process.env,
  packager = runElectronPackager,
}: {
  context: BuildContext;
  environment?: NodeJS.ProcessEnv;
  packager?: ElectronPackager;
}): Promise<string> {
  assertPackagingHost(context);
  const manifest = await readJsonFile<{
    devDependencies?: Record<string, unknown>;
    version?: unknown;
  }>(path.join(context.electronDir, "package.json"));
  const electronVersion = manifest.devDependencies?.electron;
  const appVersion = manifest.version;
  if (typeof electronVersion !== "string" || !electronVersion) {
    throw new Error("Electron manifest version is missing");
  }
  if (typeof appVersion !== "string" || !appVersion) {
    throw new Error("Electron application version is missing");
  }

  const values = createApplicationPackagerValues(context);
  const packageTypePath = path.join(
    context.stageAppDir,
    "resources",
    "package-type",
  );
  const extraResource = [
    path.join(context.stageAppDir, "resources", "app-update.yml"),
  ];
  if (context.platform === "linux") {
    // The root package installer must read this without an ASAR-aware runtime.
    extraResource.push(path.join(context.stageAppDir, "resources", "apparmor-profile"));
  }
  if (await pathExists(packageTypePath)) {
    extraResource.push(packageTypePath);
  }
  const appleOptions: Pick<ElectronPackagerOptions, "osxNotarize" | "osxSign"> =
    context.platform === "darwin" ? applePackagingOptions(environment) : {};
  const temporaryOutput = path.join(
    context.outDir,
    `.package-${context.platform}-${context.arch}-${process.pid}`,
  );
  await fs.rm(temporaryOutput, { force: true, recursive: true });
  await fs.mkdir(temporaryOutput, { recursive: true });

  try {
    const outputPaths = await packager({
      afterCopy: [
        async ({ buildPath, platform, arch }) => {
          if (arch !== context.arch || platform !== context.platform) {
            throw new Error(
              `Electron Packager hook target differs: expected ${context.platform}/${context.arch}, got ${platform}/${arch}`,
            );
          }
          await trimElectronLocales(buildPath, platform, environment);
          await applyElectronFusesToBuildPath({
            buildPath,
            hasOsxSignConfig: Boolean(appleOptions.osxSign),
            targetArch: arch,
            targetPlatform: platform,
          });
        },
      ],
      appBundleId: values.appBundleId,
      appVersion,
      arch: context.arch,
      asar: { unpack: "**/*.node" },
      dir: context.stageAppDir,
      electronVersion,
      electronZipDir: environment.ELECTRON_ZIP_DIR?.trim() || undefined,
      executableName: values.executableName,
      extendInfo: {
        NSAudioCaptureUsageDescription: `Please allow access in order to capture audio from other apps by ${values.productName}.`,
      },
      extraResource,
      icon: values.icon,
      ignore: [
        /\.map$/,
        /resources[\\/]app-update\.yml$/,
        /resources[\\/]package-type$/,
        /resources[\\/]apparmor-profile$/,
      ],
      name: values.productName,
      out: temporaryOutput,
      overwrite: false,
      platform: context.platform,
      protocols: [
        {
          name: values.productName,
          schemes: [values.protocolScheme],
        },
      ],
      prune: false,
      ...appleOptions,
    });
    if (outputPaths.length !== 1) {
      throw new Error(
        `Electron Packager produced ${outputPaths.length} application paths`,
      );
    }
    const packagedPath = path.resolve(outputPaths[0]);
    const expectedTemporaryPath = path.join(
      temporaryOutput,
      `${context.productName}-${context.platform}-${context.arch}`,
    );
    if (packagedPath !== expectedTemporaryPath) {
      throw new Error(
        `Electron Packager output differs: expected ${expectedTemporaryPath}, got ${packagedPath}`,
      );
    }

    await ensureLinuxPackageRootPermissions(packagedPath, context.platform);
    await assertPackagedLayout({
      checkoutRoot: context.repoRoot,
      packagedPath,
      productName: context.productName,
      targetPlatform: context.platform,
    });
    await adHocSignDarwinApplication({
      appPath: path.join(packagedPath, `${context.productName}.app`),
      context,
      environment,
    });
    await replaceDirectoryAtomically(packagedPath, context.packagedAppDir);
    return context.packagedAppDir;
  } finally {
    await fs.rm(temporaryOutput, { force: true, recursive: true });
  }
}
