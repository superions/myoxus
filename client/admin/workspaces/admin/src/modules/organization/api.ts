/**
 * @file SWR + mutation hooks for the Organization admin surface.
 *
 * Each query/mutation maps 1:1 to a generated `@myoxus/graphql` operation
 * exported from the codegen. Tabs in this module consume these hooks
 * directly — no intermediate state store.
 */
import {
  adminAssignOrganizationManagerMutation,
  adminAssignOrganizationUnitWorkspaceMutation,
  adminAuditLogQuery,
  adminDeactivateOrganizationUnitMutation,
  adminDeactivateOrganizationUnitTypeMutation,
  adminDecideOrganizationProjectRequestMutation,
  adminDeleteOrganizationUnitPermanentlyMutation,
  adminOrganizationExportQuery,
  adminOrganizationImportApplyMutation,
  adminOrganizationImportDryRunMutation,
  adminOrganizationPolicyQuery,
  adminOrganizationProjectRequestsQuery,
  adminOrganizationQuery,
  adminOrganizationUnitDeletionPreviewQuery,
  adminOrganizationUnitMembersQuery,
  adminOrganizationUnitsQuery,
  adminOrganizationUnitTypesQuery,
  adminOrganizationUnitWorkspacesQuery,
  adminSetOrganizationUnitParentMutation,
  adminSetOrganizationUnitStatusMutation,
  adminSetUserManagerFeatureMutation,
  adminUnassignOrganizationManagerMutation,
  adminUnassignOrganizationUnitWorkspaceMutation,
  adminUpdateOrganizationMutation,
  adminUpdateOrganizationPolicyMutation,
  adminUpsertOrganizationUnitMutation,
  adminUpsertOrganizationUnitTypeMutation,
  type AuditLogFilterInput,
  type FeatureType,
  listUsersQuery,
  OrganizationUnitStatusEnum,
  type UserLastLoginAtQuery,
  userLastLoginAtQuery,
  type UserOrganizationMembershipsQuery,
  userOrganizationMembershipsQuery,
} from "@myoxus/graphql";
import type { GraphQLError } from "graphql";
import type { SWRConfiguration } from "swr";

import { useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";

type OrganizationMembershipsQueryConfig = Omit<
  SWRConfiguration<UserOrganizationMembershipsQuery, GraphQLError>,
  "fetcher"
>;
type UserLastLoginAtQueryConfig = Omit<
  SWRConfiguration<UserLastLoginAtQuery, GraphQLError>,
  "fetcher"
>;

// ─── Queries ───────────────────────────────────────────────────────────────

export function useOrganizationQuery() {
  const response = useQuery({ query: adminOrganizationQuery });
  return { ...response, organization: response.data?.admin?.organization };
}

export function useOrganizationUnitsQuery(
  status: OrganizationUnitStatusEnum | null = OrganizationUnitStatusEnum.Active,
) {
  const response = useQuery({
    query: adminOrganizationUnitsQuery,
    variables: { status },
  });
  return { ...response, units: response.data?.admin?.organizationUnits ?? [] };
}

export function useOrganizationUnitDeletionPreviewQuery(
  unitId: string,
  enabled = true,
) {
  const response = useQuery(
    enabled && unitId
      ? {
          query: adminOrganizationUnitDeletionPreviewQuery,
          variables: { id: unitId },
        }
      : undefined,
  );
  return {
    ...response,
    preview: response.data?.admin?.organizationUnitDeletionPreview,
  };
}

export function useOrganizationUnitTypesQuery(includeInactive = false) {
  const response = useQuery({
    query: adminOrganizationUnitTypesQuery,
    variables: { includeInactive },
  });
  return {
    ...response,
    types: response.data?.admin?.organizationUnitTypes ?? [],
  };
}

export function useOrganizationUnitMembersQuery(unitId: string) {
  const response = useQuery(
    unitId
      ? {
          query: adminOrganizationUnitMembersQuery,
          variables: { unitId, role: undefined as never },
        }
      : undefined,
  );
  return {
    ...response,
    members: response.data?.admin?.organizationUnitMembers ?? [],
  };
}

export function useOrganizationUnitWorkspacesQuery(unitId: string) {
  const response = useQuery(
    unitId
      ? {
          query: adminOrganizationUnitWorkspacesQuery,
          variables: { unitId },
        }
      : undefined,
  );
  return {
    ...response,
    links: response.data?.admin?.organizationUnitWorkspaces ?? [],
  };
}

export function useOrganizationPolicyQuery() {
  const response = useQuery({ query: adminOrganizationPolicyQuery });
  return { ...response, policy: response.data?.admin?.organizationPolicy };
}

export function useOrganizationProjectRequestsQuery(status?: string) {
  const response = useQuery({
    query: adminOrganizationProjectRequestsQuery,
    variables: { status: status as never },
  });
  return {
    ...response,
    requests: response.data?.admin?.organizationProjectRequests ?? [],
  };
}

export function useOrganizationUnitAuditLogQuery(unitId: string, limit = 20) {
  const filter: AuditLogFilterInput = { targetUnitId: unitId };
  const response = useQuery(
    unitId
      ? {
          query: adminAuditLogQuery,
          variables: { filter, limit, offset: 0 },
        }
      : undefined,
  );
  return {
    ...response,
    entries: response.data?.admin?.adminAuditLog ?? [],
    totalCount: response.data?.admin?.adminAuditLogCount ?? 0,
  };
}

export function useOrganizationUsersQuery(filter?: {
  keyword?: string;
  features?: FeatureType[];
}) {
  const response = useQuery({
    query: listUsersQuery,
    variables: {
      filter: {
        first: 100,
        skip: 0,
        keyword: filter?.keyword || undefined,
        features:
          filter?.features && filter.features.length > 0
            ? filter.features
            : undefined,
      },
    },
  });
  return {
    ...response,
    users: response.data?.admin?.users ?? [],
    usersCount: response.data?.admin?.usersCount ?? 0,
  };
}

export function useUserOrganizationMembershipsQuery(
  userId: string,
  config?: OrganizationMembershipsQueryConfig,
) {
  const response = useQuery(
    userId
      ? {
          query: userOrganizationMembershipsQuery,
          variables: { userId },
        }
      : undefined,
    config,
  );
  return {
    ...response,
    memberships: response.data?.admin?.userOrganizationMemberships ?? [],
  };
}

export function useUserLastLoginAtQuery(
  userId: string,
  config?: UserLastLoginAtQueryConfig,
) {
  const response = useQuery(
    userId
      ? {
          query: userLastLoginAtQuery,
          variables: { userId },
        }
      : undefined,
    config,
  );
  return {
    ...response,
    lastLoginAt: response.data?.admin?.userLastLoginAt ?? null,
  };
}

export function useUserAuditLogQuery(userId: string, limit = 8) {
  const filter: AuditLogFilterInput = { actorUserId: userId };
  const response = useQuery(
    userId
      ? {
          query: adminAuditLogQuery,
          variables: { filter, limit, offset: 0 },
        }
      : undefined,
  );
  return {
    ...response,
    entries: response.data?.admin?.adminAuditLog ?? [],
    totalCount: response.data?.admin?.adminAuditLogCount ?? 0,
  };
}

export function useOrganizationExportQuery() {
  const response = useQuery({ query: adminOrganizationExportQuery });
  return {
    ...response,
    exportPayload: response.data?.admin?.organizationExport,
  };
}

// ─── Mutations ─────────────────────────────────────────────────────────────

export function useUpdateOrganizationMutation() {
  return useMutation({ mutation: adminUpdateOrganizationMutation });
}

export function useUpsertOrganizationUnitMutation() {
  return useMutation({ mutation: adminUpsertOrganizationUnitMutation });
}

export function useUpsertOrganizationUnitTypeMutation() {
  return useMutation({ mutation: adminUpsertOrganizationUnitTypeMutation });
}

export function useDeactivateOrganizationUnitMutation() {
  return useMutation({ mutation: adminDeactivateOrganizationUnitMutation });
}

export function useSetOrganizationUnitStatusMutation() {
  return useMutation({ mutation: adminSetOrganizationUnitStatusMutation });
}

export function useDeleteOrganizationUnitPermanentlyMutation() {
  return useMutation({
    mutation: adminDeleteOrganizationUnitPermanentlyMutation,
  });
}

export function useDeactivateOrganizationUnitTypeMutation() {
  return useMutation({ mutation: adminDeactivateOrganizationUnitTypeMutation });
}

export function useSetOrganizationUnitParentMutation() {
  return useMutation({ mutation: adminSetOrganizationUnitParentMutation });
}

export function useUpdateOrganizationPolicyMutation() {
  return useMutation({ mutation: adminUpdateOrganizationPolicyMutation });
}

export function useSetUserManagerFeatureMutation() {
  return useMutation({ mutation: adminSetUserManagerFeatureMutation });
}

export function useAssignOrganizationManagerMutation() {
  return useMutation({ mutation: adminAssignOrganizationManagerMutation });
}

export function useUnassignOrganizationManagerMutation() {
  return useMutation({ mutation: adminUnassignOrganizationManagerMutation });
}

export function useAssignOrganizationUnitWorkspaceMutation() {
  return useMutation({
    mutation: adminAssignOrganizationUnitWorkspaceMutation,
  });
}

export function useUnassignOrganizationUnitWorkspaceMutation() {
  return useMutation({
    mutation: adminUnassignOrganizationUnitWorkspaceMutation,
  });
}

export function useDecideOrganizationProjectRequestMutation() {
  return useMutation({
    mutation: adminDecideOrganizationProjectRequestMutation,
  });
}

export function useOrganizationImportDryRunMutation() {
  return useMutation({ mutation: adminOrganizationImportDryRunMutation });
}

export function useOrganizationImportApplyMutation() {
  return useMutation({ mutation: adminOrganizationImportApplyMutation });
}
