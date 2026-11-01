// SPDX-License-Identifier: AGPL-3.0-or-later

type DatabaseWorkspaceLike = {
  flavour?: string | null;
  id?: string | null;
};

export type DatabaseWorkspaceAvailability =
  | {
      reason: "server-backed";
      serverWorkspaceId: string;
      status: "available";
    }
  | {
      reason: "local-workspace" | "missing-server-binding";
      serverWorkspaceId: null;
      status: "unavailable";
    };

/**
 * Central browser/client guard for server-backed Databases. The Database
 * product contract is GraphQL/server-owned; local browser workspaces must
 * therefore stop before route, selector, slash-menu or embed code can issue a
 * Database query or mutation.
 */
export function getDatabaseWorkspaceAvailability(
  workspace: DatabaseWorkspaceLike | null | undefined,
): DatabaseWorkspaceAvailability {
  if (!workspace?.id || !workspace.flavour) {
    return {
      reason: "missing-server-binding",
      serverWorkspaceId: null,
      status: "unavailable",
    };
  }

  if (workspace.flavour === "local") {
    return {
      reason: "local-workspace",
      serverWorkspaceId: null,
      status: "unavailable",
    };
  }

  return {
    reason: "server-backed",
    serverWorkspaceId: workspace.id,
    status: "available",
  };
}

export function canUseServerBackedDatabases(
  workspace: DatabaseWorkspaceLike | null | undefined,
) {
  return getDatabaseWorkspaceAvailability(workspace).status === "available";
}
