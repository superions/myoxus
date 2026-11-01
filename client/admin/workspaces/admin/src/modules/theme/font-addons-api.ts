// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Global uploaded font add-on lifecycle for the server-owned theme catalog.
 *
 * The GraphQL fields still use their historical `pdfFont` names because the
 * server validates raw TTF/OTF material for PDF/Typst rendering first. The
 * Admin UI deliberately exposes them through Typography/Font Library instead
 * of making PDF Export the catalog owner.
 */
import {
  type AdminApprovePdfFontMutation,
  adminApprovePdfFontMutation,
  type AdminDeletePdfFontMutation,
  adminDeletePdfFontMutation,
  type AdminPdfFontQuery,
  adminPdfFontQuery,
  type AdminPdfFontsQuery,
  adminPdfFontsQuery,
  type AdminRejectPdfFontMutation,
  adminRejectPdfFontMutation,
  adminThemeCatalogQuery,
  type AdminUploadPdfFontMutation,
  adminUploadPdfFontMutation,
  type PdfFontLicenseStatusEnum,
} from "@myoxus/graphql";

import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";

export type FontAddon = AdminPdfFontsQuery["admin"]["pdfFonts"][number];
export type FontAddonDetail = NonNullable<
  AdminPdfFontQuery["admin"]["pdfFont"]
>;

const EMPTY_FONT_ADDONS: FontAddon[] = [];

export function useFontAddonsQuery(status?: PdfFontLicenseStatusEnum | null) {
  const response = useQuery({
    query: adminPdfFontsQuery,
    variables: { status: status ?? null },
  });
  return {
    ...response,
    fontAddons: response.data?.admin?.pdfFonts ?? EMPTY_FONT_ADDONS,
  };
}

export function useFontAddonQuery(id: string | null | undefined) {
  const response = useQuery(
    id ? { query: adminPdfFontQuery, variables: { id } } : undefined,
  );
  return {
    ...response,
    fontAddon: response.data?.admin?.pdfFont ?? null,
  };
}

async function revalidateFontAddonResources(
  revalidate: ReturnType<typeof useMutateQueryResource>,
  id?: string | null,
) {
  await Promise.all([
    revalidate(adminPdfFontsQuery),
    id ? revalidate(adminPdfFontQuery, (vars) => vars?.id === id) : undefined,
    revalidate(adminThemeCatalogQuery),
  ]);
}

export function useUploadFontAddonMutation() {
  const mutation = useMutation({ mutation: adminUploadPdfFontMutation });
  const revalidate = useMutateQueryResource();

  async function uploadFontAddon(input: {
    file: File;
    license?: string | null;
  }): Promise<AdminUploadPdfFontMutation["admin"]["uploadPdfFont"]> {
    const result = await mutation.trigger(input);
    await revalidateFontAddonResources(
      revalidate,
      result.admin.uploadPdfFont.id,
    );
    return result.admin.uploadPdfFont;
  }

  return { ...mutation, uploadFontAddon };
}

export function useApproveFontAddonMutation() {
  const mutation = useMutation({ mutation: adminApprovePdfFontMutation });
  const revalidate = useMutateQueryResource();

  async function approveFontAddon(
    id: string,
  ): Promise<AdminApprovePdfFontMutation["admin"]["approvePdfFont"]> {
    const result = await mutation.trigger({ id });
    await revalidateFontAddonResources(revalidate, id);
    return result.admin.approvePdfFont;
  }

  return { ...mutation, approveFontAddon };
}

export function useRejectFontAddonMutation() {
  const mutation = useMutation({ mutation: adminRejectPdfFontMutation });
  const revalidate = useMutateQueryResource();

  async function rejectFontAddon(input: {
    id: string;
    reason: string;
  }): Promise<AdminRejectPdfFontMutation["admin"]["rejectPdfFont"]> {
    const result = await mutation.trigger(input);
    await revalidateFontAddonResources(revalidate, input.id);
    return result.admin.rejectPdfFont;
  }

  return { ...mutation, rejectFontAddon };
}

export function useDeleteFontAddonMutation() {
  const mutation = useMutation({ mutation: adminDeletePdfFontMutation });
  const revalidate = useMutateQueryResource();

  async function deleteFontAddon(
    id: string,
  ): Promise<AdminDeletePdfFontMutation["admin"]["deletePdfFont"]> {
    const result = await mutation.trigger({ id });
    await revalidateFontAddonResources(revalidate, id);
    return result.admin.deletePdfFont;
  }

  return { ...mutation, deleteFontAddon };
}
