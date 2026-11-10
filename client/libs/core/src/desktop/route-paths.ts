/**
 * Canonical route path constants and path-builder helpers for the desktop
 * (and browser web) application.
 *
 * Import these constants instead of inlining path strings so that route
 * shapes are defined in a single place and refactors stay consistent across
 * the router definition, loader guards, and link helpers.
 */

/** Matches any page inside a workspace: `/workspace/:workspaceId/*`. */
export const WORKSPACE_ROUTE_PATH = "/workspace/:workspaceId/*";

/** Two segments keep the native Document key `search` available. */
export function getSearchResultsPath(query: string) {
  return `/search/results?${new URLSearchParams({ q: query })}`;
}

/**
 * Legacy share-page route kept for backwards-compatibility with old links.
 * The router redirects hits on this path to the canonical workspace-doc URL
 * via `getWorkspaceDocPath`.
 */
export const SHARE_ROUTE_PATH = "/share/:workspaceId/:pageId";

/** Dedicated 404 route rendered when a resource cannot be found. */
export const NOT_FOUND_ROUTE_PATH = "/404";

/** Catch-all route appended last in the route tree; falls through to the 404 page. */
export const CATCH_ALL_ROUTE_PATH = "*";

/**
 * Returns the canonical client-side URL for a specific document inside a workspace.
 *
 * @param workspaceId - The workspace identifier.
 * @param docId - The document (page) identifier.
 * @returns Absolute pathname string, e.g. `/workspace/ws123/doc456`.
 */
export function getWorkspaceDocPath(workspaceId: string, docId: string) {
  return `/workspace/${workspaceId}/${docId}`;
}

/** Returns the workspace-native database index URL. */
export function getDatabasesPath(workspaceId: string) {
  return `/workspace/${workspaceId}/databases`;
}

/** Returns the workspace-native database detail URL. */
export function getDatabasePath(workspaceId: string, databaseId: string) {
  return `/workspace/${workspaceId}/databases/${databaseId}`;
}

/** Returns the persistent workspace activity inbox URL. */
export function getInboxPath(workspaceId: string) {
  return `/workspace/${workspaceId}/inbox`;
}

/** Returns the canonical default dashboard URL for a workspace. */
export function getWorkspaceHomePath(workspaceId: string) {
  return `/workspace/${workspaceId}/home`;
}

export function getTasksPath(workspaceId: string) {
  return `/workspace/${workspaceId}/tasks`;
}
