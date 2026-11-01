// SPDX-License-Identifier: AGPL-3.0-or-later

export const MAX_WORKSPACE_DESCRIPTION_CODEPOINTS = 2_000;

export function normalizeWorkspaceDescription(value: string) {
  return value.replaceAll("\r\n", "\n");
}

export function countWorkspaceDescriptionCodepoints(value: string) {
  return Array.from(normalizeWorkspaceDescription(value)).length;
}
