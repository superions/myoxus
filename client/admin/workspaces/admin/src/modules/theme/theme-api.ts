// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type AdminEffectiveThemeProfileQuery,
  adminEffectiveThemeProfileQuery,
  type AdminResetWorkspaceThemeProfileMutation,
  adminResetWorkspaceThemeProfileMutation,
  type AdminSetColorSchemaValuesMutation,
  adminSetColorSchemaValuesMutation,
  type AdminSetThemeProfileMutation,
  adminSetThemeProfileMutation,
  type AdminSetTypographyStylesMutation,
  adminSetTypographyStylesMutation,
  type AdminThemeCatalogQuery,
  adminThemeCatalogQuery,
  type ColorSchemaValuePatchInput,
  type TypographyStylePatchInput,
} from "@myoxus/graphql";

import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";
import type {
  ThemeDefinition,
  ThemeFontFamily,
  ThemeMode,
  ThemeProfile,
} from "./theme-contract";

export type ThemeCatalog = NonNullable<
  AdminThemeCatalogQuery["admin"]["themeCatalog"]
>;
export type ThemeCatalogTheme = ThemeDefinition;
export type ThemeCatalogFontFamily = ThemeFontFamily;

const EMPTY_THEMES: ThemeDefinition[] = [];
const EMPTY_FONT_FAMILIES: ThemeFontFamily[] = [];

export function useThemeCatalogQuery() {
  const response = useQuery({ query: adminThemeCatalogQuery });
  return {
    ...response,
    catalog: response.data?.admin?.themeCatalog as ThemeCatalog | undefined,
    themes: (response.data?.admin?.themeCatalog?.themes ??
      EMPTY_THEMES) as ThemeDefinition[],
    fontFamilies: (response.data?.admin?.themeCatalog?.fontFamilies ??
      EMPTY_FONT_FAMILIES) as ThemeFontFamily[],
  };
}

export function useEffectiveThemeProfileQuery(workspaceId?: string | null) {
  const response = useQuery({
    query: adminEffectiveThemeProfileQuery,
    variables: { workspaceId: workspaceId ?? null },
  });
  return {
    ...response,
    profile: response.data?.admin?.effectiveThemeProfile as
      ThemeProfile | undefined,
  };
}

async function notifyRuntimeThemeUpdated() {
  try {
    const { reloadRuntimeTheme } = await import("../../runtime-theme");
    reloadRuntimeTheme();
  } catch {
    // Runtime theme reload is a best-effort UI refresh. The mutation result and
    // SWR revalidation remain authoritative; failures here must not mask a
    // successfully persisted server-side theme update.
  }

  try {
    const bc = new BroadcastChannel("myoxus-branding");
    bc.postMessage("branding-updated");
    bc.close();
  } catch {
    // BroadcastChannel is not available in every test/browser context.
  }
}

function shouldRevalidateEffectiveProfile(
  vars: { workspaceId?: string | null } | undefined,
  changedWorkspaceId: string | null | undefined,
) {
  const normalized = changedWorkspaceId ?? null;
  if (normalized === null) {
    // Global profile changes affect all workspaces that currently inherit from
    // global. The server remains authoritative for which scoped profiles are
    // overridden, so the client must revalidate every cached projection.
    return true;
  }
  return (vars?.workspaceId ?? null) === normalized;
}

export function useSetThemeProfileMutation() {
  const mutation = useMutation({ mutation: adminSetThemeProfileMutation });
  const revalidate = useMutateQueryResource();

  async function setThemeProfile(input: {
    workspaceId?: string | null;
    themeSlug: string;
    themeMode: ThemeMode;
  }): Promise<AdminSetThemeProfileMutation["admin"]["setThemeProfile"]> {
    const result = await mutation.trigger({ input });
    // The mutation acknowledgement owns success. Failed projections expose
    // their query errors for retry, but must not relabel an applied write.
    await Promise.allSettled([
      revalidate(adminThemeCatalogQuery),
      revalidate(adminEffectiveThemeProfileQuery, (vars) =>
        shouldRevalidateEffectiveProfile(vars, input.workspaceId),
      ),
    ]);
    await notifyRuntimeThemeUpdated();
    return result.admin.setThemeProfile;
  }

  return {
    ...mutation,
    setThemeProfile,
  };
}

export type { TypographyStylePatchInput };

export function useSetTypographyStylesMutation() {
  const mutation = useMutation({ mutation: adminSetTypographyStylesMutation });
  const revalidate = useMutateQueryResource();

  async function setTypographyStyles(input: {
    workspaceId?: string | null;
    styles: TypographyStylePatchInput[];
  }): Promise<
    AdminSetTypographyStylesMutation["admin"]["setTypographyStyles"]
  > {
    const result = await mutation.trigger({ typographyInput: input });
    await Promise.allSettled([
      revalidate(adminThemeCatalogQuery),
      revalidate(adminEffectiveThemeProfileQuery, (vars) =>
        shouldRevalidateEffectiveProfile(vars, input.workspaceId),
      ),
    ]);
    await notifyRuntimeThemeUpdated();
    return result.admin.setTypographyStyles;
  }

  return {
    ...mutation,
    setTypographyStyles,
  };
}

export type { ColorSchemaValuePatchInput };

export function useSetColorSchemaValuesMutation() {
  const mutation = useMutation({ mutation: adminSetColorSchemaValuesMutation });
  const revalidate = useMutateQueryResource();

  async function setColorSchemaValues(input: {
    workspaceId?: string | null;
    colors: ColorSchemaValuePatchInput[];
  }): Promise<
    AdminSetColorSchemaValuesMutation["admin"]["setColorSchemaValues"]
  > {
    const result = await mutation.trigger({ colorInput: input });
    await Promise.allSettled([
      revalidate(adminThemeCatalogQuery),
      revalidate(adminEffectiveThemeProfileQuery, (vars) =>
        shouldRevalidateEffectiveProfile(vars, input.workspaceId),
      ),
    ]);
    await notifyRuntimeThemeUpdated();
    return result.admin.setColorSchemaValues;
  }

  return {
    ...mutation,
    setColorSchemaValues,
  };
}

export function useResetWorkspaceThemeProfileMutation() {
  const mutation = useMutation({
    mutation: adminResetWorkspaceThemeProfileMutation,
  });
  const revalidate = useMutateQueryResource();

  async function resetWorkspaceThemeProfile(input: {
    workspaceId: string;
  }): Promise<
    AdminResetWorkspaceThemeProfileMutation["admin"]["resetWorkspaceThemeProfile"]
  > {
    const result = await mutation.trigger({ resetInput: input });
    await Promise.allSettled([
      revalidate(adminThemeCatalogQuery),
      revalidate(
        adminEffectiveThemeProfileQuery,
        (vars) => (vars?.workspaceId ?? null) === input.workspaceId,
      ),
    ]);
    await notifyRuntimeThemeUpdated();
    return result.admin.resetWorkspaceThemeProfile;
  }

  return {
    ...mutation,
    resetWorkspaceThemeProfile,
  };
}

export type { AdminEffectiveThemeProfileQuery };
