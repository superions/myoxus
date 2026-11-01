// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type AppUpdater,
  DebUpdater,
  MacUpdater,
  NsisUpdater,
  RpmUpdater,
} from "electron-updater";

import type { DesktopUpdateTarget } from "./update-manifest";

export type DesktopUpdaterSelection =
  | {
      state: "enabled";
      target: DesktopUpdateTarget;
      updater: AppUpdater;
    }
  | {
      state: "disabled";
      reason:
        | "externally-managed"
        | "missing-package-marker"
        | "portable"
        | "unsupported-architecture"
        | "unsupported-package-marker"
        | "unsupported-platform";
    };

type DesktopEnvironment = {
  arch: NodeJS.Architecture;
  environment: NodeJS.ProcessEnv;
  flatpakInfoExists: boolean;
  packageMarker: string | null;
  platform: NodeJS.Platform;
};

function packageMarker(resourcesPath: string): string | null {
  try {
    return readFileSync(
      path.join(resourcesPath, "package-type"),
      "utf8",
    ).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function resolveDesktopUpdater(
  input: DesktopEnvironment,
  factories: {
    deb: () => AppUpdater;
    macos: () => AppUpdater;
    nsis: () => AppUpdater;
    rpm: () => AppUpdater;
  } = {
    deb: () => new DebUpdater(),
    macos: () => new MacUpdater(),
    nsis: () => new NsisUpdater(),
    rpm: () => new RpmUpdater(),
  },
): DesktopUpdaterSelection {
  if (input.arch !== "arm64" && input.arch !== "x64") {
    return { state: "disabled", reason: "unsupported-architecture" };
  }

  if (input.platform === "darwin") {
    return {
      state: "enabled",
      updater: factories.macos(),
      target: { platform: "darwin", arch: input.arch, backend: "macos" },
    };
  }

  if (input.platform === "win32") {
    if (input.packageMarker === null) {
      return { state: "disabled", reason: "portable" };
    }
    if (input.packageMarker !== "nsis") {
      return { state: "disabled", reason: "unsupported-package-marker" };
    }
    return {
      state: "enabled",
      updater: factories.nsis(),
      target: { platform: "win32", arch: input.arch, backend: "nsis" },
    };
  }

  if (input.platform === "linux") {
    if (input.environment.FLATPAK_ID || input.flatpakInfoExists) {
      return { state: "disabled", reason: "externally-managed" };
    }
    if (input.packageMarker === null) {
      return { state: "disabled", reason: "missing-package-marker" };
    }
    if (input.packageMarker !== "deb" && input.packageMarker !== "rpm") {
      return { state: "disabled", reason: "unsupported-package-marker" };
    }
    return {
      state: "enabled",
      updater:
        input.packageMarker === "deb" ? factories.deb() : factories.rpm(),
      target: {
        platform: "linux",
        arch: input.arch,
        backend: input.packageMarker,
      },
    };
  }

  return { state: "disabled", reason: "unsupported-platform" };
}

export function selectDesktopUpdater(
  resourcesPath = process.resourcesPath,
): DesktopUpdaterSelection {
  return resolveDesktopUpdater({
    arch: process.arch,
    environment: process.env,
    flatpakInfoExists: existsSync("/.flatpak-info"),
    packageMarker: packageMarker(resourcesPath),
    platform: process.platform,
  });
}
