// SPDX-License-Identifier: AGPL-3.0-or-later

const OPERATION_QUERY_KEY = "workspaceContentOperation";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Keeps only the durable server operation identifier in the current route.
 *
 * This is intentionally not a client operation cache: the dialog resolves the
 * identifier against the server after reload and never restores status,
 * permissions, content metadata or an optimistic result from browser storage.
 */
export function projectWorkspaceContentOperationToLocation(
  operationId: string,
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set(OPERATION_QUERY_KEY, operationId);
  window.history.replaceState(window.history.state, "", url);
}

export function clearWorkspaceContentOperationFromLocation(
  operationId?: string,
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (
    operationId &&
    url.searchParams.get(OPERATION_QUERY_KEY) !== operationId
  ) {
    return;
  }
  url.searchParams.delete(OPERATION_QUERY_KEY);
  window.history.replaceState(window.history.state, "", url);
}

export function workspaceContentOperationFromLocation() {
  if (typeof window === "undefined") return null;
  const operationId = new URL(window.location.href).searchParams.get(
    OPERATION_QUERY_KEY,
  );
  return operationId && UUID_PATTERN.test(operationId) ? operationId : null;
}
