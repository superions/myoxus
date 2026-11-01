// SPDX-License-Identifier: AGPL-3.0-or-later

export type WorkspacePageKind = "document" | "database";

export interface WorkspacePageIdentity {
  id: string;
  kind: WorkspacePageKind;
}

const WORKSPACE_PAGE_KEY_SEPARATOR = ":";

/**
 * Persist and render Page identities with their capability-bearing kind.
 * Raw document and Database IDs may overlap, so callers must never key a
 * mixed Page collection by ID alone.
 */
export function workspacePageKey(identity: WorkspacePageIdentity): string {
  return `${identity.kind}${WORKSPACE_PAGE_KEY_SEPARATOR}${identity.id}`;
}

export function parseWorkspacePageKey(
  key: string,
): WorkspacePageIdentity | null {
  const separator = key.indexOf(WORKSPACE_PAGE_KEY_SEPARATOR);
  if (separator < 1 || separator === key.length - 1) return null;

  const kind = key.slice(0, separator);
  if (kind !== "document" && kind !== "database") return null;

  return {
    kind,
    id: key.slice(separator + 1),
  };
}
