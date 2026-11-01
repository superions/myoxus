// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** @vitest-environment happy-dom */
import {
  adminAppServerBrandingQuery,
  adminOrganizationIdentityQuery,
} from "@myoxus/graphql";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  trigger: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("../../use-mutation", () => ({
  useMutation: vi.fn(() => ({
    trigger: apiMocks.trigger,
    isMutating: false,
  })),
  useMutateQueryResource: vi.fn(() => apiMocks.revalidate),
}));

vi.mock("../../use-query", () => ({
  useQuery: vi.fn((options: { query: { id: string } }) => ({
    data:
      options.query.id === adminOrganizationIdentityQuery.id
        ? {
            admin: {
              organizationIdentity: {
                displayName: "Acme",
                legalName: null,
                shortName: null,
                jurisdiction: null,
                websiteUrl: null,
                contactEmail: null,
                addressLines: [],
                taxId: null,
                registrationId: null,
              },
            },
          }
        : {
            admin: {
              appServerBranding: {
                logo: null,
                productMark: null,
                faviconPack: null,
              },
            },
          },
  })),
}));

import {
  useUpdateAppServerBrandingMutation,
  useUpdateOrganizationIdentityMutation,
} from "./brand-identity-api";

describe("brand-identity-api", () => {
  beforeEach(() => {
    apiMocks.trigger.mockReset();
    apiMocks.revalidate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("updateOrganizationIdentity revalidates only organization identity", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        updateOrganizationIdentity: {
          displayName: "Acme Labs",
        },
      },
    });

    const { result } = renderHook(() =>
      useUpdateOrganizationIdentityMutation(),
    );
    await act(async () => {
      await result.current.updateOrganizationIdentity({
        displayName: "Acme Labs",
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      input: { displayName: "Acme Labs" },
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(
      adminOrganizationIdentityQuery,
    );
    expect(apiMocks.revalidate).not.toHaveBeenCalledWith(
      adminAppServerBrandingQuery,
    );
  });

  test("updateAppServerBranding revalidates only app/server branding", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        updateAppServerBranding: {
          logo: null,
          productMark: null,
          faviconPack: null,
        },
      },
    });

    const { result } = renderHook(() => useUpdateAppServerBrandingMutation());
    await act(async () => {
      await result.current.updateAppServerBranding({
        logoAssetId: "asset-logo",
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      input: { logoAssetId: "asset-logo" },
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(
      adminAppServerBrandingQuery,
    );
    expect(apiMocks.revalidate).not.toHaveBeenCalledWith(
      adminOrganizationIdentityQuery,
    );
  });
});
