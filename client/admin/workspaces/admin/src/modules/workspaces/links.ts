const ADMIN_FRONTEND_SEGMENT = "/adminfrontend";

function normalizeSubPath(subPath: string | undefined): string {
  if (!subPath || subPath === "/") {
    return "";
  }

  const withLeadingSlash = subPath.startsWith("/") ? subPath : `/${subPath}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/**
 * Derive the web-frontend base path from the admin frontend sub-path.
 * Examples:
 * - `/adminfrontend` -> ``
 * - `/myoxus/adminfrontend` -> `/myoxus`
 */
export function getWorkspaceBasePath(subPath: string | undefined): string {
  const normalized = normalizeSubPath(subPath);

  if (!normalized) {
    return "";
  }

  if (normalized === ADMIN_FRONTEND_SEGMENT) {
    return "";
  }

  if (normalized.endsWith(ADMIN_FRONTEND_SEGMENT)) {
    return normalized.slice(0, -ADMIN_FRONTEND_SEGMENT.length);
  }

  return normalized;
}

export function buildGitSyncSettingsPath(
  workspaceId: string,
  subPath: string | undefined,
): string {
  const basePath = getWorkspaceBasePath(subPath);
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  const params = new URLSearchParams({ tab: "workspace:integrations" });

  return `${basePath}/workspace/${encodedWorkspaceId}/settings?${params.toString()}`;
}

export function buildGitSyncSettingsUrl(
  workspaceId: string,
  subPath: string | undefined,
  origin: string,
): string {
  return new URL(
    buildGitSyncSettingsPath(workspaceId, subPath),
    origin,
  ).toString();
}
