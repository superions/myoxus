// SPDX-License-Identifier: AGPL-3.0-or-later

import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type ElectronBuildType = "stable" | "beta" | "internal";
export type ElectronTargetPlatform = "darwin" | "linux" | "win32";
export type ElectronTargetArch = "arm64" | "x64";
export type ElectronTargetLibc = "gnu" | "musl";

export interface ElectronNativeTarget {
  arch: ElectronTargetArch;
  libc?: ElectronTargetLibc;
  platform: ElectronTargetPlatform;
  triple: string;
}

export interface BuildContext {
  appId: string;
  appIconSvg: string;
  arch: ElectronTargetArch;
  buildType: ElectronBuildType;
  electronDir: string;
  macosIcns: string;
  makeDir: string;
  outDir: string;
  packageName: string;
  packagedAppDir: string;
  platform: ElectronTargetPlatform;
  productName: string;
  protocolScheme: string;
  rendererDir: string;
  repoRoot: string;
  runtimeIconPng: string;
  stageAppDir: string;
  windowsIco: string;
}

const electronDir = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = path.resolve(electronDir, "..", "..", "..");
const appIds: Record<ElectronBuildType, string> = {
  beta: "org.myoxus.beta",
  internal: "org.myoxus.internal",
  stable: "org.myoxus.desktop",
};

function oneOf<T extends string>(
  value: string,
  values: readonly T[],
  label: string,
): T {
  if (!values.includes(value as T)) {
    throw new Error(
      `${label} must be one of ${values.join(", ")}; got ${value}`,
    );
  }
  return value as T;
}

export function createBuildContext(
  environment: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): BuildContext {
  const { values } = parseArgs({
    args: argv,
    options: {
      arch: { type: "string", default: process.arch },
      platform: { type: "string", default: process.platform },
    },
    allowPositionals: true,
    strict: false,
  });
  const buildType = oneOf(
    (environment.BUILD_TYPE ?? "stable").trim().toLowerCase(),
    ["stable", "beta", "internal"] as const,
    "BUILD_TYPE",
  );
  const platform = oneOf(
    String(values.platform ?? process.platform),
    ["darwin", "linux", "win32"] as const,
    "platform",
  );
  const arch = oneOf(
    String(values.arch ?? process.arch),
    ["arm64", "x64"] as const,
    "arch",
  );
  const productName = buildType === "stable" ? "Myoxus" : `Myoxus-${buildType}`;
  const packageName = productName.toLowerCase();
  const outDir = path.join(electronDir, "out", buildType);
  const stageAppDir = path.join(outDir, "stage", `${platform}-${arch}`, "app");
  const stageIconsDir = path.join(stageAppDir, "resources", "icons");

  return {
    appId: appIds[buildType],
    appIconSvg: path.join(stageIconsDir, "app-icon.svg"),
    arch,
    buildType,
    electronDir,
    macosIcns: path.join(stageIconsDir, "app-icon.icns"),
    makeDir: path.join(outDir, "make"),
    outDir,
    packageName,
    packagedAppDir: path.join(outDir, `${productName}-${platform}-${arch}`),
    platform,
    productName,
    protocolScheme: packageName,
    rendererDir: path.join(repoRoot, "client", "apps", "electron-renderer"),
    repoRoot,
    runtimeIconPng: path.join(stageIconsDir, "app-icon.png"),
    stageAppDir,
    windowsIco: path.join(stageIconsDir, "app-icon.ico"),
  };
}

export function targetTripleFor(
  platform: ElectronTargetPlatform,
  arch: ElectronTargetArch,
  libc: ElectronTargetLibc = "gnu",
): string {
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "win32") {
    return arch === "arm64"
      ? "aarch64-pc-windows-msvc"
      : "x86_64-pc-windows-msvc";
  }
  return `${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-${libc}`;
}

export function nativeTargetFromTriple(
  triple: string,
): ElectronNativeTarget | null {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    for (const arch of ["arm64", "x64"] as const) {
      const libcValues =
        platform === "linux" ? (["gnu", "musl"] as const) : (["gnu"] as const);
      for (const libc of libcValues) {
        if (targetTripleFor(platform, arch, libc) === triple) {
          return {
            arch,
            ...(platform === "linux" ? { libc } : {}),
            platform,
            triple,
          };
        }
      }
    }
  }
  return null;
}

export function nativeBuildEnvironment(
  context: BuildContext,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const triple =
    environment.TARGET ?? targetTripleFor(context.platform, context.arch);
  const target = nativeTargetFromTriple(triple);
  if (target?.platform !== context.platform || target.arch !== context.arch) {
    throw new Error(
      `Native TARGET ${triple} differs from package ${context.platform}/${context.arch}`,
    );
  }
  return {
    ...environment,
    MYOXUS_NATIVE_PLATFORM: context.platform,
    MYOXUS_NATIVE_ARCH: context.arch,
    TARGET: triple,
    CARGO_BUILD_TARGET: triple,
  };
}
