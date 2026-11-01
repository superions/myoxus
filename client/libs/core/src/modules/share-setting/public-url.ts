// SPDX-License-Identifier: AGPL-3.0-or-later

/** Build the canonical anonymous workspace root against the configured server. */
export function canonicalPublicWorkspaceUrl({
  baseUrl,
  workspaceId,
}: {
  baseUrl: string;
  workspaceId: string;
}) {
  return new URL(`/public/${workspaceId}`, baseUrl).toString();
}
