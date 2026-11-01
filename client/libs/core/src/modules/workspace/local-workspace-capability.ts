// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

type LocalWorkspaceBuildConfig = {
  isAndroid?: boolean;
  isElectron?: boolean;
  isIOS?: boolean;
};

function getBuildConfig(): LocalWorkspaceBuildConfig {
  const runtimeConfig =
    (globalThis as { BUILD_CONFIG?: LocalWorkspaceBuildConfig }).BUILD_CONFIG ??
    {};

  try {
    return {
      ...runtimeConfig,
      isAndroid: BUILD_CONFIG.isAndroid,
      isElectron: BUILD_CONFIG.isElectron,
      isIOS: BUILD_CONFIG.isIOS,
    };
  } catch {
    return runtimeConfig;
  }
}

/**
 * Local workspaces are a native/offline capability. Browser web clients must
 * not create or persist local workspace metadata because the server is the
 * authoritative workspace source there; Electron and native mobile retain the
 * local storage path.
 */
export function canUseLocalWorkspaces(
  config: LocalWorkspaceBuildConfig = getBuildConfig(),
) {
  return Boolean(config.isElectron || config.isIOS || config.isAndroid);
}
