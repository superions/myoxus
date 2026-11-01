// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type AdminAppServerBrandingQuery,
  adminAppServerBrandingQuery,
  type AdminOrganizationIdentityQuery,
  adminOrganizationIdentityQuery,
  type AdminUpdateAppServerBrandingMutation,
  adminUpdateAppServerBrandingMutation,
  type AdminUpdateOrganizationIdentityMutation,
  adminUpdateOrganizationIdentityMutation,
  type UpdateAppServerBrandingInput,
  type UpdateOrganizationIdentityInput,
} from "@myoxus/graphql";

import { useMutateQueryResource, useMutation } from "../../use-mutation";
import { useQuery } from "../../use-query";

export type AppServerBrandingAdmin = NonNullable<
  AdminAppServerBrandingQuery["admin"]["appServerBranding"]
>;

export type OrganizationIdentityAdmin = NonNullable<
  AdminOrganizationIdentityQuery["admin"]["organizationIdentity"]
>;

export function useAppServerBrandingQuery() {
  const response = useQuery({ query: adminAppServerBrandingQuery });
  return {
    ...response,
    branding: response.data?.admin?.appServerBranding as
      AppServerBrandingAdmin | undefined,
  };
}

export function useOrganizationIdentityQuery() {
  const response = useQuery({ query: adminOrganizationIdentityQuery });
  return {
    ...response,
    identity: response.data?.admin?.organizationIdentity as
      OrganizationIdentityAdmin | undefined,
  };
}

export function useUpdateOrganizationIdentityMutation() {
  const mutation = useMutation({
    mutation: adminUpdateOrganizationIdentityMutation,
  });
  const revalidate = useMutateQueryResource();

  async function updateOrganizationIdentity(
    input: UpdateOrganizationIdentityInput,
  ): Promise<
    AdminUpdateOrganizationIdentityMutation["admin"]["updateOrganizationIdentity"]
  > {
    const result = await mutation.trigger({ input });
    await revalidate(adminOrganizationIdentityQuery);
    return result.admin.updateOrganizationIdentity;
  }

  return {
    ...mutation,
    updateOrganizationIdentity,
  };
}

export function useUpdateAppServerBrandingMutation() {
  const mutation = useMutation({
    mutation: adminUpdateAppServerBrandingMutation,
  });
  const revalidate = useMutateQueryResource();

  async function updateAppServerBranding(
    input: UpdateAppServerBrandingInput,
  ): Promise<
    AdminUpdateAppServerBrandingMutation["admin"]["updateAppServerBranding"]
  > {
    const result = await mutation.trigger({ input });
    await revalidate(adminAppServerBrandingQuery);
    return result.admin.updateAppServerBranding;
  }

  return {
    ...mutation,
    updateAppServerBranding,
  };
}

export type { UpdateAppServerBrandingInput, UpdateOrganizationIdentityInput };
