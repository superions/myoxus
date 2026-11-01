import {
  adminRetireTemplateAssignmentMutation,
  adminTriggerDriftScanMutation,
  applyTemplateManualUpdateMutation,
  archiveTemplateMutation,
  assignTemplateToWorkspaceMutation,
  disableTemplateMutation,
  enableTemplateMutation,
  importTemplateMutation,
  type ProvisioningModeType,
  publishRevisionMutation,
  type SelectionModeType,
  setTemplateDefaultPolicyMutation,
  templateAssignmentsQuery,
  templateCatalogQuery,
  templateDefaultPoliciesQuery,
  templateJobsQuery,
  templateRevisionsQuery,
  type TemplateStatusType,
  triggerReconcileMutation,
  updateBuiltinTemplateMetadataMutation,
  workspaceTemplateInstancesQuery,
  workspaceTemplateSourcesQuery,
} from "@myoxus/graphql";
import { useCallback } from "react";

import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { gqlFetcher, useQuery } from "../../use-query";

type PaginationVars = { skip?: number; take?: number };

export function useWorkspaceTemplateSourcesQuery(
  workspaceId: string | null,
  variables: PaginationVars = {},
) {
  const response = useQuery(
    workspaceId
      ? {
          query: workspaceTemplateSourcesQuery,
          variables: { workspaceId, ...variables },
        }
      : undefined,
  );
  return {
    ...response,
    sources: response.data?.admin.workspaceTemplateSources.sources ?? [],
    nextOffset:
      response.data?.admin.workspaceTemplateSources.nextOffset ?? null,
  };
}

export function useTemplateCatalogQuery(
  variables: PaginationVars & { status?: TemplateStatusType },
  config?: Parameters<typeof useQuery<typeof templateCatalogQuery>>[1],
) {
  const response = useQuery(
    {
      query: templateCatalogQuery,
      variables,
    },
    config,
  );
  return {
    ...response,
    entries: response.data?.admin?.templateCatalog ?? [],
    totalCount: response.data?.admin?.templateCatalogCount ?? 0,
  };
}

export function useTemplateAssignmentsQuery(
  workspaceId: string,
  variables: PaginationVars = {},
) {
  const response = useQuery({
    query: templateAssignmentsQuery,
    variables: { workspaceId, ...variables },
  });
  return {
    ...response,
    assignments: response.data?.admin?.templateAssignments ?? [],
  };
}

export function useTemplateRevisionsQuery(
  templateId: string | null,
  variables: PaginationVars = {},
) {
  const response = useQuery(
    templateId
      ? {
          query: templateRevisionsQuery,
          variables: { templateId, ...variables },
        }
      : undefined,
  );
  return {
    ...response,
    revisions: response.data?.admin?.templateRevisions ?? [],
  };
}

export function useTemplateJobsQuery(variables: PaginationVars = {}) {
  const response = useQuery({
    query: templateJobsQuery,
    variables: { skip: 0, take: 50, ...variables },
  });
  return {
    ...response,
    jobs: response.data?.admin?.templateJobs ?? [],
  };
}

export function useWorkspaceTemplateInstancesQuery(workspaceId: string) {
  const response = useQuery({
    query: workspaceTemplateInstancesQuery,
    variables: { workspaceId },
  });
  return {
    ...response,
    instances: response.data?.admin?.workspaceTemplateInstances ?? [],
  };
}

export function usePublishRevisionMutation() {
  return useMutation({
    mutation: publishRevisionMutation,
  });
}

export function useAssignTemplateToWorkspaceMutation() {
  return useMutation({
    mutation: assignTemplateToWorkspaceMutation,
  });
}

export function useRemoveTemplateAssignmentMutation() {
  return useMutation({
    mutation: adminRetireTemplateAssignmentMutation,
  });
}

export function useTriggerTemplateReconcileMutation() {
  return useMutation({
    mutation: triggerReconcileMutation,
  });
}

export function useApplyTemplateManualUpdateMutation() {
  return useMutation({
    mutation: applyTemplateManualUpdateMutation,
  });
}

export function useTemplateRegistryRevalidate() {
  const revalidate = useMutateQueryResource();

  const revalidateCatalog = useCallback(
    () => revalidate(templateCatalogQuery),
    [revalidate],
  );
  const revalidateAssignments = useCallback(
    (workspaceId?: string) =>
      revalidate(
        templateAssignmentsQuery,
        workspaceId
          ? (vars) =>
              String((vars as { workspaceId?: unknown })?.workspaceId) ===
              workspaceId
          : () => true,
      ),
    [revalidate],
  );
  const revalidateRevisions = useCallback(
    () => revalidate(templateRevisionsQuery),
    [revalidate],
  );
  const revalidateJobs = useCallback(
    () => revalidate(templateJobsQuery),
    [revalidate],
  );
  const revalidateWorkspaceInstances = useCallback(
    (workspaceId?: string) =>
      revalidate(
        workspaceTemplateInstancesQuery,
        workspaceId
          ? (vars) =>
              String((vars as { workspaceId?: unknown })?.workspaceId) ===
              workspaceId
          : () => true,
      ),
    [revalidate],
  );
  const revalidateDefaultPolicies = useCallback(
    () => revalidate(templateDefaultPoliciesQuery),
    [revalidate],
  );

  return {
    revalidateCatalog,
    revalidateAssignments,
    revalidateRevisions,
    revalidateJobs,
    revalidateWorkspaceInstances,
    revalidateDefaultPolicies,
  };
}

export async function archiveTemplate(templateId: string) {
  return gqlFetcher({
    query: archiveTemplateMutation,
    variables: { templateId },
  });
}

export async function enableTemplate(templateId: string) {
  return gqlFetcher({
    query: enableTemplateMutation,
    variables: { templateId },
  });
}

export async function disableTemplate(templateId: string) {
  return gqlFetcher({
    query: disableTemplateMutation,
    variables: { templateId },
  });
}

export async function importTemplateBundle(file: File) {
  return gqlFetcher({
    query: importTemplateMutation,
    variables: { file },
  });
}

export async function assignTemplateToWorkspace(args: {
  workspaceId: string;
  templateId: string;
  provisioningMode: ProvisioningModeType;
  selectionMode: SelectionModeType;
  selectedRevisionId?: string;
}) {
  return gqlFetcher({
    query: assignTemplateToWorkspaceMutation,
    variables: args,
  });
}

export async function removeTemplateAssignment(assignmentId: string) {
  return gqlFetcher({
    query: adminRetireTemplateAssignmentMutation,
    variables: { policyId: assignmentId },
  });
}

export async function triggerTemplateReconcile(args: {
  workspaceId: string;
  templateId: string;
}) {
  return gqlFetcher({
    query: triggerReconcileMutation,
    variables: args,
  });
}

export async function triggerTemplateDriftScan(workspaceId: string) {
  return gqlFetcher({
    query: adminTriggerDriftScanMutation,
    variables: { workspaceId },
  });
}

export function useTemplateDefaultPoliciesQuery() {
  const response = useQuery({
    query: templateDefaultPoliciesQuery,
    variables: undefined,
  });
  return {
    ...response,
    policies: response.data?.admin?.templateDefaultPolicies ?? [],
  };
}

/** Update category and/or tags of a builtin template. Title, description and slug are read-only for builtins. */
export async function updateBuiltinTemplateMetadata(args: {
  templateId: string;
  category?: string;
  tags?: string[];
}) {
  return gqlFetcher({
    query: updateBuiltinTemplateMetadataMutation,
    variables: args,
  });
}

/** Create or update a template default policy (controls automatic seeding of new workspaces). */
export async function setTemplateDefaultPolicy(args: {
  templateId: string;
  applyToNewWorkspaces: boolean;
  selectionMode: SelectionModeType;
  provisioningMode: ProvisioningModeType;
}) {
  return gqlFetcher({
    query: setTemplateDefaultPolicyMutation,
    variables: args,
  });
}
