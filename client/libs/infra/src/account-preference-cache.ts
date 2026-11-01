// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

type CachedTelemetryPreference = {
  confirmedEffectiveValues?: { telemetryEnabled?: boolean };
  pendingPatch?: { telemetryEnabled?: boolean | null };
};

/**
 * Reads the last account-scoped telemetry decision before dependency injection
 * is available. Pending offline intent wins over the last acknowledged value.
 */
export function readCachedTelemetryPreference(
  storage: Storage,
  serverId?: string,
): boolean | undefined {
  const readServerPreference = (candidateServerId: string) => {
    try {
      const session = JSON.parse(
        storage.getItem(`global-state:${candidateServerId}-auth`) ?? "null",
      ) as { account?: { id?: string } } | null;
      const userId = session?.account?.id;
      if (!userId) return undefined;
      const cached = JSON.parse(
        storage.getItem(
          `global-state:user-preferences:${candidateServerId}:${userId}`,
        ) ?? "null",
      ) as CachedTelemetryPreference | null;
      return (
        cached?.pendingPatch?.telemetryEnabled ??
        cached?.confirmedEffectiveValues?.telemetryEnabled
      );
    } catch {
      return undefined;
    }
  };

  if (serverId) return readServerPreference(serverId);

  let enabled: boolean | undefined;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith("global-state:") || !key.endsWith("-auth")) {
      continue;
    }
    const candidateServerId = key.slice(
      "global-state:".length,
      key.length - "-auth".length,
    );
    const candidate = readServerPreference(candidateServerId);
    if (candidate === false) return false;
    if (candidate === true) enabled = true;
  }
  return enabled;
}
