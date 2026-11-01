// SPDX-License-Identifier: MIT

import type { TagColorRole } from "@myoxus/ui-facade";

/**
 * Server-owned workspace-tag roles in their canonical presentation order.
 * The Facade remains responsible for resolving each role to visual tokens.
 */
export const WORKSPACE_TAG_COLOR_ROLES = [
  "tag.red",
  "tag.magenta",
  "tag.orange",
  "tag.yellow",
  "tag.green",
  "tag.teal",
  "tag.blue",
  "tag.purple",
  "tag.grey",
] as const satisfies readonly TagColorRole[];

const workspaceTagColorRoleSet = new Set<string>(WORKSPACE_TAG_COLOR_ROLES);

export function isWorkspaceTagColorRole(value: unknown): value is TagColorRole {
  return typeof value === "string" && workspaceTagColorRoleSet.has(value);
}

/** Defensive display fallback for non-authoritative import diagnostics. */
export function workspaceTagColorRoleOrGrey(value: unknown): TagColorRole {
  return isWorkspaceTagColorRole(value) ? value : "tag.grey";
}
