// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AdminUpdateWorkspaceMutation,
  AdminWorkspaceQuery,
  AdminWorkspacesListQuery,
  FeatureType,
} from "@myoxus/graphql";

type WorkspaceListPayload = AdminWorkspacesListQuery["admin"];
type WorkspaceQueryPayload = AdminWorkspaceQuery["admin"];

export type WorkspaceListItem = WorkspaceListPayload["adminWorkspaces"][number];
export type WorkspaceDetail = NonNullable<
  WorkspaceQueryPayload["adminWorkspace"]
>;
export type WorkspaceMember = WorkspaceDetail["members"][number];
export type WorkspaceUpdateInput =
  AdminUpdateWorkspaceMutation["admin"]["adminUpdateWorkspace"];

export type WorkspaceFeatureFilter = FeatureType[];

export interface WorkspaceFlagFilter {
  public?: boolean;
  enableAi?: boolean;
  enableSharing?: boolean;
  enableUrlPreview?: boolean;
  enableDocEmbedding?: boolean;
}

export type WorkspaceTypeFilter = "all" | "personal" | "user-owned" | "shared";
export type WorkspaceGitSyncFilter =
  | "all"
  | "enabled"
  | "disabled"
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
