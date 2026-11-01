// SPDX-License-Identifier: AGPL-3.0-or-later

export type DatabaseUnavailableStatus =
  "forbidden" | "local-unavailable" | "missing" | "offline" | "unavailable";

export type DatabaseRouteStatus =
  "loading" | "ready" | DatabaseUnavailableStatus;

/**
 * Builds the canonical Database detail route. Omitting a View deliberately
 * delegates default-View selection to the server-ordered detail host.
 */
export function databaseRoute(
  databaseId: string,
  viewId?: string | null,
): string {
  if (!viewId) return `/databases/${databaseId}`;
  return `/databases/${databaseId}?${new URLSearchParams({ viewId })}`;
}

function isBrowserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function appendErrorText(error: unknown, parts: string[]) {
  if (!error) return;
  if (Array.isArray(error)) {
    error.forEach((item) => appendErrorText(item, parts));
    return;
  }
  if (error instanceof Error) {
    parts.push(error.message);
  }
  if (typeof error === "string") {
    parts.push(error);
  }
  if (typeof error === "object") {
    const value = error as {
      code?: unknown;
      extensions?: { code?: unknown; name?: unknown; message?: unknown };
      message?: unknown;
      name?: unknown;
    };
    for (const candidate of [
      value.code,
      value.name,
      value.message,
      value.extensions?.code,
      value.extensions?.name,
      value.extensions?.message,
    ]) {
      if (typeof candidate === "string") {
        parts.push(candidate);
      }
    }
  }
}

export function classifyDatabaseError(
  error: unknown,
): DatabaseUnavailableStatus {
  if (isBrowserOffline()) {
    return "offline";
  }

  const parts: string[] = [];
  appendErrorText(error, parts);
  const message = parts.join(" ");
  if (/MIX_DATABASE_FORBIDDEN|forbidden|permission/i.test(message)) {
    return "forbidden";
  }
  if (/MIX_DATABASE_NOT_FOUND|not found/i.test(message)) {
    return "missing";
  }
  return "unavailable";
}

export function getDatabaseIndexRouteStatus({
  dataLoaded,
  error,
  hasWorkspace,
  isLoading,
}: {
  dataLoaded: boolean;
  error?: unknown;
  hasWorkspace: boolean;
  isLoading?: boolean;
}): DatabaseRouteStatus {
  if (error) {
    return classifyDatabaseError(error);
  }
  if (!dataLoaded || (isLoading && !hasWorkspace)) {
    return "loading";
  }
  return hasWorkspace ? "ready" : "unavailable";
}

export function getDatabaseUnavailableWorkspaceRouteStatus({
  reason,
}: {
  reason: "local-workspace" | "missing-server-binding";
}): DatabaseUnavailableStatus {
  return reason === "local-workspace" ? "local-unavailable" : "unavailable";
}

export function getDatabaseDetailRouteStatus({
  databaseDataLoaded,
  databaseError,
  hasActiveView,
  hasDatabase,
  hasRowsConnection,
  hasWorkspace,
  isDatabaseLoading,
  isRowsLoading,
  rowDataLoaded,
  rowError,
}: {
  databaseDataLoaded: boolean;
  databaseError?: unknown;
  hasActiveView: boolean;
  hasDatabase: boolean;
  hasRowsConnection: boolean;
  hasWorkspace: boolean;
  isDatabaseLoading?: boolean;
  isRowsLoading?: boolean;
  rowDataLoaded: boolean;
  rowError?: unknown;
}): DatabaseRouteStatus {
  if (databaseError) {
    return classifyDatabaseError(databaseError);
  }
  if (rowError) {
    return classifyDatabaseError(rowError);
  }
  if (
    !databaseDataLoaded ||
    !rowDataLoaded ||
    isDatabaseLoading ||
    isRowsLoading
  ) {
    return "loading";
  }
  if (!hasWorkspace || !hasRowsConnection) {
    return "unavailable";
  }
  if (!hasDatabase) {
    return "missing";
  }
  if (!hasActiveView) {
    return "unavailable";
  }
  return "ready";
}
