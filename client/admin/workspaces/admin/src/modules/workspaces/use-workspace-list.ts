// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@myoxus/admin/use-query";
import {
  adminWorkspacesListQuery,
  type AdminWorkspaceSort,
  type FeatureType,
  GitSyncRunStatus,
  WorkspaceTypeFilter as WorkspaceTypeFilterEnum,
} from "@myoxus/graphql";
import { useMemo } from "react";

import { useFilterPagination } from "../../hooks/use-filter-pagination";
import type {
  WorkspaceFlagFilter,
  WorkspaceGitSyncFilter,
  WorkspaceTypeFilter,
} from "./schema";

interface WorkspaceListFilter {
  keyword?: string;
  features?: FeatureType[];
  orderBy?: AdminWorkspaceSort;
  flags?: WorkspaceFlagFilter;
  typeFilter?: WorkspaceTypeFilter;
  gitSyncFilter?: WorkspaceGitSyncFilter;
}

const WORKSPACE_TYPE_FILTERS: Partial<
  Record<WorkspaceTypeFilter, WorkspaceTypeFilterEnum>
> = {
  shared: WorkspaceTypeFilterEnum.Shared,
  personal: WorkspaceTypeFilterEnum.Personal,
  "user-owned": WorkspaceTypeFilterEnum.UserOwned,
};

const GIT_SYNC_STATUS_FILTERS: Partial<
  Record<WorkspaceGitSyncFilter, GitSyncRunStatus>
> = {
  pending: GitSyncRunStatus.Pending,
  running: GitSyncRunStatus.Running,
  completed: GitSyncRunStatus.Completed,
  failed: GitSyncRunStatus.Failed,
  cancelled: GitSyncRunStatus.Cancelled,
};

function enabledFilter(value: WorkspaceGitSyncFilter | undefined) {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  return undefined;
}

export function useWorkspaceList(filter: WorkspaceListFilter = {}) {
  const filterIdentity = useMemo(
    () =>
      JSON.stringify({
        ...filter,
        features: [...(filter.features ?? [])].sort(),
      }),
    [filter],
  );
  const { pagination, setPagination } = useFilterPagination(filterIdentity);
  const variables = useMemo(
    () => ({
      filter: {
        first: pagination.pageSize,
        skip: pagination.pageIndex * pagination.pageSize,
        keyword: filter.keyword?.trim() || undefined,
        features: filter.features?.length ? filter.features : undefined,
        orderBy: filter.orderBy,
        workspaceType: filter.typeFilter
          ? WORKSPACE_TYPE_FILTERS[filter.typeFilter]
          : undefined,
        gitSyncEnabled: enabledFilter(filter.gitSyncFilter),
        gitSyncLastStatus: filter.gitSyncFilter
          ? GIT_SYNC_STATUS_FILTERS[filter.gitSyncFilter]
          : undefined,
        public: filter.flags?.public,
        enableAi: filter.flags?.enableAi,
        enableSharing: filter.flags?.enableSharing,
        enableUrlPreview: filter.flags?.enableUrlPreview,
        enableDocEmbedding: filter.flags?.enableDocEmbedding,
      },
    }),
    [filter, pagination.pageIndex, pagination.pageSize],
  );
  const query = useQuery(
    { query: adminWorkspacesListQuery, variables },
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      revalidateIfStale: true,
      revalidateOnReconnect: true,
    },
  );

  return {
    workspaces: query.data?.admin?.adminWorkspaces ?? [],
    workspacesCount: query.data?.admin?.adminWorkspacesCount ?? 0,
    pagination,
    setPagination,
    loading: query.isValidating || query.data === undefined,
  };
}
