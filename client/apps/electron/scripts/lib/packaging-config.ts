// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { PUBLIC_PROJECT_URLS } from "@myoxus-tools/utils/public-urls";

import type { BuildContext } from "./build-context";
import { readJsonFile } from "./native-files";

export type ElectronArtifactPlatform = "linux" | "macos" | "windows";
export type ElectronPackageTarget =
  "deb" | "dmg" | "flatpak" | "nsis" | "rpm" | "zip";

export interface PackagingIdentity {
  appId: string;
  appIconSvg: string;
  arch: BuildContext["arch"];
  artifactName: (extension: string) => string;
  buildType: BuildContext["buildType"];
  macosIcns: string;
  packageName: string;
  platform: BuildContext["platform"];
  productName: string;
  protocolScheme: string;
  runtimeIconPng: string;
  version: string;
  windowsIco: string;
}

/** Ubuntu's executable-scoped policy permits Chromium's user namespace sandbox. */
export function materializeLinuxAppArmor(
  identity: Pick<PackagingIdentity, "productName">,
): string {
  const name = identity.productName;
  return `# SPDX-License-Identifier: AGPL-3.0-or-later\nabi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${name} /opt/${name}/${name} flags=(unconfined) {\n  userns,\n  include if exists <local/${name}>\n}\n`;
}

export function materializeLinuxMetainfo(
  template: string,
  identity: Pick<
    PackagingIdentity,
    "appId" | "productName" | "protocolScheme" | "version"
  >,
): string {
  const metainfo = template
    .replace(/<id>.*?<\/id>/, `<id>${identity.appId}</id>`)
    .replace(/<name>.*?<\/name>/, `<name>${identity.productName}</name>`)
    .replace("__MYOXUS_VERSION__", identity.version)
    .replace(
      /<mediatype>x-scheme-handler\/.*?<\/mediatype>/,
      `<mediatype>x-scheme-handler/${identity.protocolScheme}</mediatype>`,
    )
    .replace(
      /<launchable type="desktop-id">.*?<\/launchable>/,
      `<launchable type="desktop-id">${identity.productName}.desktop</launchable>`,
    )
    .replaceAll("__MYOXUS_HOMEPAGE_URL__", PUBLIC_PROJECT_URLS.repository)
    .replaceAll("__MYOXUS_ISSUES_URL__", PUBLIC_PROJECT_URLS.issues)
    .replaceAll("__MYOXUS_HELP_URL__", PUBLIC_PROJECT_URLS.documentation)
    .replaceAll("__MYOXUS_SOURCE_URL__", PUBLIC_PROJECT_URLS.repository);
  if (metainfo.includes("__MYOXUS_") || !metainfo.includes(identity.version)) {
    throw new Error("Linux metainfo template was not fully materialized");
  }
  return metainfo;
}

function artifactPlatform(
  platform: BuildContext["platform"],
): ElectronArtifactPlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export function assertPackagingTarget(context: BuildContext): void {
  const supported =
    (context.platform === "linux" && context.arch === "x64") ||
    context.platform === "darwin" ||
    (context.platform === "win32" && context.arch === "x64");
  if (!supported) {
    throw new Error(
      `Unsupported packaging target ${context.platform}/${context.arch}; ` +
        "supported targets are linux/x64, darwin/arm64, darwin/x64, and win32/x64",
    );
  }
}

export function createPackagingIdentity(
  context: BuildContext,
  version: string,
): PackagingIdentity {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Electron release version: ${version}`);
  }
  const artifactPrefix = [
    "myoxus",
    version,
    context.buildType,
    artifactPlatform(context.platform),
    context.arch,
  ].join("-");
  return {
    appId: context.appId,
    appIconSvg: context.appIconSvg,
    arch: context.arch,
    artifactName: (extension) => `${artifactPrefix}.${extension}`,
    buildType: context.buildType,
    macosIcns: context.macosIcns,
    packageName: context.packageName,
    platform: context.platform,
    productName: context.productName,
    protocolScheme: context.protocolScheme,
    runtimeIconPng: context.runtimeIconPng,
    version,
    windowsIco: context.windowsIco,
  };
}

export async function loadPackagingIdentity(
  context: BuildContext,
): Promise<PackagingIdentity> {
  const manifest = await readJsonFile<Record<string, unknown>>(
    path.join(context.electronDir, "package.json"),
  );
  return createPackagingIdentity(context, String(manifest.version ?? ""));
}

export function createApplicationPackagerValues(context: BuildContext) {
  const icon =
    context.platform === "darwin"
      ? context.macosIcns
      : context.platform === "win32"
        ? context.windowsIco
        : context.runtimeIconPng;
  return {
    appBundleId: context.appId,
    executableName: context.productName,
    icon,
    productName: context.productName,
    protocolScheme: context.protocolScheme,
  };
}
