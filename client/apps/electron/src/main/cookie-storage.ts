// SPDX-License-Identifier: AGPL-3.0-or-later

import { chmod, mkdir } from "node:fs/promises";

import { app } from "electron";

import { globalStateStorage } from "./shared-storage/storage";

const storagePolicy = "macos-profile-cookies-v1";

/** macOS ad-hoc updates cannot retain a Keychain code identity. Cookie values
 * therefore use the owner-only profile, while other platforms keep OS crypto.
 * New native cookie partitions avoid opening the old encrypted databases.
 * Only their cached account projection expires once; documents, server
 * registrations, preferences and subsequent authenticated sessions survive. */
export async function prepareDesktopCookieStorage(
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "darwin") return;

  for (const directory of new Set([
    app.getPath("userData"),
    app.getPath("sessionData"),
  ])) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  if (globalStateStorage.get(storagePolicy) === true) return;
  for (const key of globalStateStorage.keys()) {
    if (key.endsWith("-auth")) globalStateStorage.del(key);
  }
  globalStateStorage.set(storagePolicy, true);
  // Commit before launching a renderer: a later quit must not be needed to
  // remember that the one-time sign-in transition already happened.
  await globalStateStorage.flush();
}
