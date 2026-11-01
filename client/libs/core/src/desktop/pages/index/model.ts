// SPDX-License-Identifier: AGPL-3.0-or-later

export function selectDefaultWorkspace<T extends { id: string }>(
  workspaces: readonly T[],
  lastWorkspaceId: string | null,
) {
  return (
    workspaces.find((workspace) => workspace.id === lastWorkspaceId) ??
    workspaces[0] ??
    null
  );
}
