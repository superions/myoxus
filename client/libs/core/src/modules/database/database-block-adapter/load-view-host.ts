// SPDX-License-Identifier: AGPL-3.0-or-later

type ViewHost = typeof import("../view-host").DatabaseViewHost;
let request: Promise<ViewHost> | undefined;

// Ready embeds share delivery and successful evaluation. Release a rejected
// attempt so retry can recover without clearing server data or document state.
export function loadDatabaseViewHost(): Promise<ViewHost> {
  return (request ??= import("../view-host")
    .then((module) => module.DatabaseViewHost)
    .catch((error: unknown) => {
      request = undefined;
      throw error;
    }));
}
