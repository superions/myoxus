/**
 * @file PDF export admin — templates, ICC, and brand assets hooks.
 *
 * Wraps every PDF-export-V2 admin operation in a typed SWR-aware hook so
 * components can stay free of GraphQL plumbing.  Every mutation hook
 * returns the live mutator plus typed `ok` / `error` channels so the
 * caller can render toasts and re-load the relevant query.
 *
 * Surfaces:
 *  - `usePdfTemplatesQuery` / `usePdfTemplateQuery` / `usePdfTemplateFilesQuery`
 *  - `useUploadPdfTemplateMutation` / `useDeletePdfTemplateMutation` /
 *    `useUpdatePdfTemplateMetadataMutation`
 *  - `usePdfWorkspaceAssignmentsQuery` /
 *    `usePdfTemplateAssignedWorkspacesQuery` /
 *    `useAssignPdfTemplateToWorkspaceMutation` /
 *    `useUnassignPdfTemplateFromWorkspaceMutation` /
 *    `useSetWorkspaceDefaultPdfTemplateMutation`
 *  - `usePdfIccProfilesQuery` / `usePdfIccProfileQuery` /
 *    `useUploadIccProfileMutation` / `useDeleteIccProfileMutation`
 *  - `useDocumentBrandingProfileQuery`, `useDocumentBrandColorPalettesQuery`
 *    plus document branding mutations.
 *  - `usePdfExportSettingsQuery` / `useUpdatePdfExportSettingsMutation`.
 *
 * The hooks are intentionally thin: they preserve the SWR / mutation
 * contract used by the rest of the admin frontend (see
 * `modules/templates/api.ts` for the precedent). The components own the
 * UX and toasting.
 */
import {
  adminAssignPdfTemplateToWorkspaceMutation,
  adminCancelPdfExportJobMutation,
  type AdminDeleteDocumentBrandLogoMutation,
  adminDeleteDocumentBrandLogoMutation,
  type AdminDeleteDocumentBrandLogoMutationVariables,
  adminDeleteIccProfileMutation,
  adminDeletePdfTemplateMutation,
  type AdminDocumentBrandColorPalettesQuery,
  adminDocumentBrandColorPalettesQuery,
  type AdminDocumentBrandingProfileQuery,
  adminDocumentBrandingProfileQuery,
  type AdminPdfExportJobsQuery,
  adminPdfExportJobsQuery,
  type AdminPdfExportJobsQueryVariables,
  type AdminPdfExportSettingsQuery,
  adminPdfExportSettingsQuery,
  adminPdfIccProfileQuery,
  adminPdfIccProfilesQuery,
  adminPdfTemplateAssignedWorkspacesQuery,
  adminPdfTemplateFilesQuery,
  adminPdfTemplatePreviewPdfQuery,
  adminPdfTemplateQuery,
  adminPdfTemplatesQuery,
  adminPdfWorkspaceAssignmentsQuery,
  adminReplacePdfTemplateBundleMutation,
  type AdminResetWorkspaceDocumentBrandingMutation,
  adminResetWorkspaceDocumentBrandingMutation,
  type AdminResetWorkspaceDocumentBrandingMutationVariables,
  type AdminSetDocumentBrandingColorPolicyMutation,
  adminSetDocumentBrandingColorPolicyMutation,
  type AdminSetDocumentBrandingColorPolicyMutationVariables,
  type AdminSetWorkspaceDefaultPdfTemplateMutation,
  adminSetWorkspaceDefaultPdfTemplateMutation,
  type AdminSetWorkspaceDefaultPdfTemplateMutationVariables,
  adminUnassignPdfTemplateFromWorkspaceMutation,
  type AdminUpdateDocumentBrandingColorsMutation,
  adminUpdateDocumentBrandingColorsMutation,
  type AdminUpdateDocumentBrandingColorsMutationVariables,
  type AdminUpdateDocumentBrandingTextMutation,
  adminUpdateDocumentBrandingTextMutation,
  type AdminUpdateDocumentBrandingTextMutationVariables,
  type AdminUpdatePdfExportSettingsMutation,
  adminUpdatePdfExportSettingsMutation,
  type AdminUpdatePdfExportSettingsMutationVariables,
  adminUpdatePdfTemplateMetadataMutation,
  type AdminUploadDocumentBrandLogoMutation,
  adminUploadDocumentBrandLogoMutation,
  type AdminUploadDocumentBrandLogoMutationVariables,
  adminUploadIccProfileMutation,
  adminUploadPdfTemplateMutation,
  type BrandLogoKind,
  type DocumentBrandColorPolicy,
  documentVersioningAdminSettingsQuery,
  type PdfIccProfileTypeEnum,
  updateDocumentVersioningWorkspaceSettingsMutation,
} from "@myoxus/graphql";

import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";

export type DocumentBrandingProfileAdmin = NonNullable<
  AdminDocumentBrandingProfileQuery["admin"]["documentBrandingProfile"]
>;

export type DocumentBrandColorPaletteAdmin =
  AdminDocumentBrandColorPalettesQuery["admin"]["documentBrandColorPalettes"][number];

export type PdfExportSettings = NonNullable<
  AdminPdfExportSettingsQuery["admin"]["pdfExportSettings"]
>;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** List PDF templates. Pass `includeDeleted: true` for the diagnostic view. */
export function usePdfTemplatesQuery(includeDeleted = false) {
  const response = useQuery({
    query: adminPdfTemplatesQuery,
    variables: { includeDeleted },
  });
  return {
    ...response,
    templates: response.data?.admin?.pdfTemplates ?? [],
  };
}

/** Fetch a single template by id. */
export function usePdfTemplateQuery(id: string | null) {
  const response = useQuery(
    id
      ? {
          query: adminPdfTemplateQuery,
          variables: { id },
        }
      : undefined,
  );
  return {
    ...response,
    template: response.data?.admin?.pdfTemplate ?? null,
  };
}

/** List the manifest-declared bundle files of a template. */
export function usePdfTemplateFilesQuery(templateId: string | null) {
  const response = useQuery(
    templateId
      ? {
          query: adminPdfTemplateFilesQuery,
          variables: { templateId },
        }
      : undefined,
  );
  return {
    ...response,
    files: response.data?.admin?.pdfTemplateFiles ?? [],
  };
}

/** Render a server-side validator-stub preview PDF for the selected template. */
export function usePdfTemplatePreviewPdfQuery(
  templateId: string | null,
  locale = "en-US",
) {
  const response = useQuery(
    templateId
      ? {
          query: adminPdfTemplatePreviewPdfQuery,
          variables: { templateId, locale },
        }
      : undefined,
  );
  return {
    ...response,
    pdfBase64: response.data?.admin?.pdfTemplatePreviewPdf ?? null,
  };
}

export function useUploadPdfTemplateMutation() {
  return useMutation({ mutation: adminUploadPdfTemplateMutation });
}

export function useReplacePdfTemplateBundleMutation() {
  const revalidate = useMutateQueryResource();
  return useMutation(
    { mutation: adminReplacePdfTemplateBundleMutation },
    {
      onSuccess: async (result) => {
        const id = result.admin.replacePdfTemplateBundle.id;
        // Replacement preserves identity, so ID-keyed bundle consumers must
        // discard the previous revision even when their tab is not mounted.
        await Promise.all([
          revalidate(adminPdfTemplatesQuery),
          revalidate(adminPdfTemplateQuery, (vars) => vars?.id === id),
          revalidate(
            adminPdfTemplateFilesQuery,
            (vars) => vars?.templateId === id,
            { clearCachedData: true },
          ),
          revalidate(
            adminPdfTemplatePreviewPdfQuery,
            (vars) => vars?.templateId === id,
            { clearCachedData: true },
          ),
        ]);
      },
    },
  );
}

export function useDeletePdfTemplateMutation() {
  return useMutation({ mutation: adminDeletePdfTemplateMutation });
}

export function useUpdatePdfTemplateMetadataMutation() {
  return useMutation({ mutation: adminUpdatePdfTemplateMetadataMutation });
}

// ---------------------------------------------------------------------------
// Workspace assignments
// ---------------------------------------------------------------------------

export function usePdfWorkspaceAssignmentsQuery(workspaceId: string | null) {
  const response = useQuery(
    workspaceId
      ? {
          query: adminPdfWorkspaceAssignmentsQuery,
          variables: { workspaceId },
        }
      : undefined,
  );
  return {
    ...response,
    assignments: response.data?.admin?.pdfWorkspaceAssignments ?? [],
  };
}

export function usePdfTemplateAssignedWorkspacesQuery(
  templateId: string | null,
) {
  const response = useQuery(
    templateId
      ? {
          query: adminPdfTemplateAssignedWorkspacesQuery,
          variables: { templateId },
        }
      : undefined,
  );
  return {
    ...response,
    assignments: response.data?.admin?.pdfTemplateAssignedWorkspaces ?? [],
  };
}

export function useAssignPdfTemplateToWorkspaceMutation() {
  return useMutation({ mutation: adminAssignPdfTemplateToWorkspaceMutation });
}

export function useUnassignPdfTemplateFromWorkspaceMutation() {
  return useMutation({
    mutation: adminUnassignPdfTemplateFromWorkspaceMutation,
  });
}

export function useSetWorkspaceDefaultPdfTemplateMutation() {
  const mutation = useMutation({
    mutation: adminSetWorkspaceDefaultPdfTemplateMutation,
  });
  const revalidate = useMutateQueryResource();

  async function setWorkspaceDefaultPdfTemplate(
    variables: AdminSetWorkspaceDefaultPdfTemplateMutationVariables,
  ): Promise<
    AdminSetWorkspaceDefaultPdfTemplateMutation["admin"]["setWorkspaceDefaultPdfTemplate"]
  > {
    const result = await mutation.trigger(variables);
    await Promise.all([
      revalidate(
        adminPdfExportSettingsQuery,
        (vars) => vars?.workspaceId === variables.workspaceId,
      ),
      revalidate(
        adminPdfWorkspaceAssignmentsQuery,
        (vars) => vars?.workspaceId === variables.workspaceId,
      ),
    ]);
    return result.admin.setWorkspaceDefaultPdfTemplate;
  }

  return {
    ...mutation,
    setWorkspaceDefaultPdfTemplate,
  };
}

// ---------------------------------------------------------------------------
// ICC color profiles
// ---------------------------------------------------------------------------

export function usePdfIccProfilesQuery() {
  const response = useQuery({ query: adminPdfIccProfilesQuery });
  return {
    ...response,
    profiles: response.data?.admin?.pdfIccProfiles ?? [],
  };
}

export function usePdfIccProfileQuery(id: string | null) {
  const response = useQuery(
    id
      ? {
          query: adminPdfIccProfileQuery,
          variables: { id },
        }
      : undefined,
  );
  return {
    ...response,
    profile: response.data?.admin?.pdfIccProfile ?? null,
  };
}

export function useUploadIccProfileMutation() {
  return useMutation({ mutation: adminUploadIccProfileMutation });
}

export function useDeleteIccProfileMutation() {
  return useMutation({ mutation: adminDeleteIccProfileMutation });
}

// ---------------------------------------------------------------------------
// Document branding + PDF export settings
// ---------------------------------------------------------------------------

export function useDocumentBrandingProfileQuery(workspaceId: string | null) {
  const response = useQuery(
    workspaceId
      ? {
          query: adminDocumentBrandingProfileQuery,
          variables: { workspaceId },
        }
      : undefined,
  );
  return {
    ...response,
    profile: response.data?.admin?.documentBrandingProfile ?? null,
  };
}

export function useDocumentBrandColorPalettesQuery(workspaceId: string | null) {
  const response = useQuery(
    workspaceId
      ? {
          query: adminDocumentBrandColorPalettesQuery,
          variables: { workspaceId },
        }
      : undefined,
  );
  return {
    ...response,
    palettes: response.data?.admin?.documentBrandColorPalettes ?? [],
  };
}

export function usePdfExportSettingsQuery(workspaceId: string | null) {
  const response = useQuery(
    workspaceId
      ? {
          query: adminPdfExportSettingsQuery,
          variables: { workspaceId },
        }
      : undefined,
  );
  return {
    ...response,
    settings: response.data?.admin?.pdfExportSettings ?? null,
  };
}

export function useUploadDocumentBrandLogoMutation() {
  const mutation = useMutation({
    mutation: adminUploadDocumentBrandLogoMutation,
  });
  const revalidate = useMutateQueryResource();

  async function uploadDocumentBrandLogo(
    variables: AdminUploadDocumentBrandLogoMutationVariables,
  ): Promise<
    AdminUploadDocumentBrandLogoMutation["admin"]["uploadDocumentBrandLogo"]
  > {
    const result = await mutation.trigger(variables);
    await revalidate(
      adminDocumentBrandingProfileQuery,
      (vars) => vars?.workspaceId === variables.workspaceId,
    );
    return result.admin.uploadDocumentBrandLogo;
  }

  return {
    ...mutation,
    uploadDocumentBrandLogo,
  };
}

export function useDeleteDocumentBrandLogoMutation() {
  const mutation = useMutation({
    mutation: adminDeleteDocumentBrandLogoMutation,
  });
  const revalidate = useMutateQueryResource();

  async function deleteDocumentBrandLogo(
    variables: AdminDeleteDocumentBrandLogoMutationVariables,
  ): Promise<
    AdminDeleteDocumentBrandLogoMutation["admin"]["deleteDocumentBrandLogo"]
  > {
    const result = await mutation.trigger(variables);
    await revalidate(
      adminDocumentBrandingProfileQuery,
      (vars) => vars?.workspaceId === variables.workspaceId,
    );
    return result.admin.deleteDocumentBrandLogo;
  }

  return {
    ...mutation,
    deleteDocumentBrandLogo,
  };
}

export function useResetWorkspaceDocumentBrandingMutation() {
  const mutation = useMutation({
    mutation: adminResetWorkspaceDocumentBrandingMutation,
  });
  const revalidate = useMutateQueryResource();

  async function resetWorkspaceDocumentBranding(
    variables: AdminResetWorkspaceDocumentBrandingMutationVariables,
  ): Promise<
    AdminResetWorkspaceDocumentBrandingMutation["admin"]["resetWorkspaceDocumentBranding"]
  > {
    const result = await mutation.trigger(variables);
    await revalidate(
      adminDocumentBrandingProfileQuery,
      (vars) => vars?.workspaceId === variables.workspaceId,
    );
    return result.admin.resetWorkspaceDocumentBranding;
  }

  return {
    ...mutation,
    resetWorkspaceDocumentBranding,
  };
}

export function useUpdateDocumentBrandingTextMutation() {
  const mutation = useMutation({
    mutation: adminUpdateDocumentBrandingTextMutation,
  });
  const revalidate = useMutateQueryResource();

  async function updateDocumentBrandingText(
    variables: AdminUpdateDocumentBrandingTextMutationVariables,
  ): Promise<
    AdminUpdateDocumentBrandingTextMutation["admin"]["updateDocumentBrandingText"]
  > {
    const result = await mutation.trigger(variables);
    await revalidate(
      adminDocumentBrandingProfileQuery,
      (vars) => vars?.workspaceId === variables.workspaceId,
    );
    return result.admin.updateDocumentBrandingText;
  }

  return {
    ...mutation,
    updateDocumentBrandingText,
  };
}

export function useUpdateDocumentBrandingColorsMutation() {
  const mutation = useMutation({
    mutation: adminUpdateDocumentBrandingColorsMutation,
  });
  const revalidate = useMutateQueryResource();

  async function updateDocumentBrandingColors(
    variables: AdminUpdateDocumentBrandingColorsMutationVariables,
  ): Promise<
    AdminUpdateDocumentBrandingColorsMutation["admin"]["updateDocumentBrandingColors"]
  > {
    const result = await mutation.trigger(variables);
    await revalidate(
      adminDocumentBrandingProfileQuery,
      (vars) => vars?.workspaceId === variables.workspaceId,
    );
    return result.admin.updateDocumentBrandingColors;
  }

  return {
    ...mutation,
    updateDocumentBrandingColors,
  };
}

export function useSetDocumentBrandingColorPolicyMutation() {
  const mutation = useMutation({
    mutation: adminSetDocumentBrandingColorPolicyMutation,
  });
  const revalidate = useMutateQueryResource();

  async function setDocumentBrandingColorPolicy(
    variables: AdminSetDocumentBrandingColorPolicyMutationVariables,
  ): Promise<
    AdminSetDocumentBrandingColorPolicyMutation["admin"]["setDocumentBrandingColorPolicy"]
  > {
    const result = await mutation.trigger(variables);
    await revalidate(
      adminDocumentBrandingProfileQuery,
      (vars) => vars?.workspaceId === variables.workspaceId,
    );
    return result.admin.setDocumentBrandingColorPolicy;
  }

  return {
    ...mutation,
    setDocumentBrandingColorPolicy,
  };
}

export type { DocumentBrandColorPolicy };

export function useUpdatePdfExportSettingsMutation() {
  const mutation = useMutation({
    mutation: adminUpdatePdfExportSettingsMutation,
  });
  const revalidate = useMutateQueryResource();

  async function updatePdfExportSettings(
    variables: AdminUpdatePdfExportSettingsMutationVariables,
  ): Promise<
    AdminUpdatePdfExportSettingsMutation["admin"]["updatePdfExportSettings"]
  > {
    const result = await mutation.trigger(variables);
    await revalidate(
      adminPdfExportSettingsQuery,
      (vars) => vars?.workspaceId === variables.workspaceId,
    );
    return result.admin.updatePdfExportSettings;
  }

  return {
    ...mutation,
    updatePdfExportSettings,
  };
}

// ---------------------------------------------------------------------------
// Document-versioning defaults
// ---------------------------------------------------------------------------

export interface DocumentVersioningDefaults {
  defaultEnabled: boolean;
  defaultAutoVersionOnPdfExport: boolean;
  defaultRetentionCount: number;
  defaultEditCaptureEnabled: boolean;
  defaultEditCaptureIntervalMs: number;
}

export interface DocumentVersioningWorkspaceSettings {
  workspaceId: string;
  workspaceName: string | null;
  enabled: boolean | null;
  autoVersionOnPdfExport: boolean | null;
  retentionCount: number | null;
  effectiveEnabled: boolean;
  effectiveAutoVersionOnPdfExport: boolean;
  effectiveRetentionCount: number;
  editCaptureEnabled: boolean | null;
  editCaptureIntervalMs: number | null;
  effectiveEditCaptureEnabled: boolean;
  effectiveEditCaptureIntervalMs: number;
  legacyIntervalNormalized: boolean;
  editCaptureRuntimeAvailable: boolean;
  updatedAt: string | null;
}

interface DocumentVersioningAdminSettingsResponse {
  admin?: {
    documentVersioningDefaults?: DocumentVersioningDefaults;
    documentVersioningWorkspaceSettings?: DocumentVersioningWorkspaceSettings[];
  };
}

export function useDocumentVersioningAdminSettingsQuery() {
  const response = useQuery({
    query: documentVersioningAdminSettingsQuery,
  });
  const data = response.data as
    DocumentVersioningAdminSettingsResponse | undefined;
  return {
    ...response,
    defaults: data?.admin?.documentVersioningDefaults ?? null,
    workspaceSettings: data?.admin?.documentVersioningWorkspaceSettings ?? [],
  };
}

export function useUpdateDocumentVersioningWorkspaceSettingsMutation() {
  return useMutation({
    mutation: updateDocumentVersioningWorkspaceSettingsMutation,
  });
}

// ---------------------------------------------------------------------------
// Render jobs
// ---------------------------------------------------------------------------

export type PdfExportJobStatusFilter = NonNullable<
  NonNullable<AdminPdfExportJobsQueryVariables["filter"]>["status"]
>;
export type PdfExportAdminJob =
  AdminPdfExportJobsQuery["admin"]["pdfExportJobs"][number];

export interface PdfExportJobsFilters {
  status?: PdfExportJobStatusFilter;
  workspaceId?: string;
  userId?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
}

export function useAdminPdfExportJobsQuery(filters: PdfExportJobsFilters) {
  const response = useQuery(
    {
      query: adminPdfExportJobsQuery,
      variables: { filter: filters },
    },
    { refreshInterval: 5000 },
  );
  return {
    ...response,
    jobs: response.data?.admin?.pdfExportJobs ?? [],
  };
}

export function useCancelPdfExportJobMutation() {
  return useMutation({ mutation: adminCancelPdfExportJobMutation });
}

export type { BrandLogoKind, PdfIccProfileTypeEnum };
