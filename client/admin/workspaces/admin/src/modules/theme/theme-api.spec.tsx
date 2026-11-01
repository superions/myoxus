// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** @vitest-environment happy-dom */
import {
  adminEffectiveThemeProfileQuery,
  adminThemeCatalogQuery,
} from "@myoxus/graphql";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  trigger: vi.fn(),
  revalidate: vi.fn(),
  useQuery: vi.fn(),
  reloadRuntimeTheme: vi.fn(),
  channelName: vi.fn(),
  postMessage: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../use-mutation", () => ({
  useMutation: vi.fn(() => ({
    trigger: apiMocks.trigger,
    isMutating: false,
  })),
  useMutateQueryResource: vi.fn(() => apiMocks.revalidate),
}));

vi.mock("../../use-query", () => ({
  useQuery: apiMocks.useQuery,
}));

vi.mock("../../runtime-theme", () => ({
  reloadRuntimeTheme: apiMocks.reloadRuntimeTheme,
}));

import {
  useResetWorkspaceThemeProfileMutation,
  useSetColorSchemaValuesMutation,
  useSetThemeProfileMutation,
  useSetTypographyStylesMutation,
} from "./theme-api";

const BRANDING_PROFILE = {
  scope: "global",
  workspaceId: null,
  themeMode: "system",
  theme: null,
};

function effectiveProfileRevalidationPredicate() {
  const call = apiMocks.revalidate.mock.calls.find(
    ([query, predicate]) =>
      query === adminEffectiveThemeProfileQuery &&
      typeof predicate === "function",
  );
  expect(call).toBeTruthy();
  return call?.[1] as (vars?: { workspaceId?: string | null }) => boolean;
}

describe("theme-api mutations", () => {
  beforeEach(() => {
    apiMocks.trigger.mockReset();
    apiMocks.revalidate.mockReset();
    apiMocks.useQuery.mockReset();
    apiMocks.useQuery.mockReturnValue({
      data: {
        admin: {
          themeCatalog: {
            themes: [],
            fontFamilies: [],
          },
          effectiveThemeProfile: null,
        },
      },
    });
    apiMocks.reloadRuntimeTheme.mockReset();
    apiMocks.channelName.mockReset();
    apiMocks.postMessage.mockReset();
    apiMocks.close.mockReset();

    vi.stubGlobal(
      "BroadcastChannel",
      class {
        constructor(name: string) {
          apiMocks.channelName(name);
        }

        postMessage(message: string) {
          apiMocks.postMessage(message);
        }

        close() {
          apiMocks.close();
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("setThemeProfile revalidates typed AdminRoot resources and refreshes runtime CSS", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        setThemeProfile: BRANDING_PROFILE,
      },
    });

    const { result } = renderHook(() => useSetThemeProfileMutation());
    await act(async () => {
      await result.current.setThemeProfile({
        workspaceId: null,
        themeSlug: "vienna-workshop",
        themeMode: "dark",
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      input: {
        workspaceId: null,
        themeSlug: "vienna-workshop",
        themeMode: "dark",
      },
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminThemeCatalogQuery);
    expect(apiMocks.revalidate).toHaveBeenCalledWith(
      adminEffectiveThemeProfileQuery,
      expect.any(Function),
    );
    const shouldRevalidate = effectiveProfileRevalidationPredicate();
    expect(shouldRevalidate({ workspaceId: null })).toBe(true);
    expect(shouldRevalidate({ workspaceId: "workspace-1" })).toBe(true);
    expect(apiMocks.reloadRuntimeTheme).toHaveBeenCalledOnce();
    expect(apiMocks.channelName).toHaveBeenCalledWith("myoxus-branding");
    expect(apiMocks.postMessage).toHaveBeenCalledWith("branding-updated");
    expect(apiMocks.close).toHaveBeenCalledOnce();
  });

  test("setTypographyStyles uses the canonical mutation variable and refreshes runtime CSS", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        setTypographyStyles: BRANDING_PROFILE,
      },
    });
    const styles = [
      {
        styleKey: "pdf.body",
        fontFamilySlug: "catalog-serif",
        fontWeight: 500,
      },
    ];

    const { result } = renderHook(() => useSetTypographyStylesMutation());
    await act(async () => {
      await result.current.setTypographyStyles({
        workspaceId: "workspace-1",
        styles,
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      typographyInput: {
        workspaceId: "workspace-1",
        styles,
      },
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminThemeCatalogQuery);
    expect(apiMocks.revalidate).toHaveBeenCalledWith(
      adminEffectiveThemeProfileQuery,
      expect.any(Function),
    );
    const shouldRevalidate = effectiveProfileRevalidationPredicate();
    expect(shouldRevalidate({ workspaceId: "workspace-1" })).toBe(true);
    expect(shouldRevalidate({ workspaceId: "workspace-2" })).toBe(false);
    expect(shouldRevalidate({ workspaceId: null })).toBe(false);
    expect(apiMocks.reloadRuntimeTheme).toHaveBeenCalledOnce();
    expect(apiMocks.postMessage).toHaveBeenCalledWith("branding-updated");
  });

  test("setColorSchemaValues uses the canonical mutation variable and refreshes runtime CSS", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        setColorSchemaValues: BRANDING_PROFILE,
      },
    });
    const colors = [
      {
        mode: "light",
        tokenKey: "accent-primary",
        value: "#123456",
      },
      {
        mode: "dark",
        tokenKey: "accent-secondary",
        value: "#abcdef",
      },
    ];

    const { result } = renderHook(() => useSetColorSchemaValuesMutation());
    await act(async () => {
      await result.current.setColorSchemaValues({
        workspaceId: "workspace-1",
        colors,
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      colorInput: {
        workspaceId: "workspace-1",
        colors,
      },
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminThemeCatalogQuery);
    expect(apiMocks.revalidate).toHaveBeenCalledWith(
      adminEffectiveThemeProfileQuery,
      expect.any(Function),
    );
    expect(apiMocks.reloadRuntimeTheme).toHaveBeenCalledOnce();
    expect(apiMocks.postMessage).toHaveBeenCalledWith("branding-updated");
  });

  test("resetWorkspaceThemeProfile uses the canonical variable and refreshes scoped profile", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        resetWorkspaceThemeProfile: {
          ...BRANDING_PROFILE,
          scope: "global",
        },
      },
    });

    const { result } = renderHook(() =>
      useResetWorkspaceThemeProfileMutation(),
    );
    await act(async () => {
      await result.current.resetWorkspaceThemeProfile({
        workspaceId: "workspace-1",
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      resetInput: {
        workspaceId: "workspace-1",
      },
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminThemeCatalogQuery);
    const shouldRevalidate = effectiveProfileRevalidationPredicate();
    expect(shouldRevalidate({ workspaceId: "workspace-1" })).toBe(true);
    expect(shouldRevalidate({ workspaceId: "workspace-2" })).toBe(false);
    expect(apiMocks.reloadRuntimeTheme).toHaveBeenCalledOnce();
    expect(apiMocks.postMessage).toHaveBeenCalledWith("branding-updated");
  });

  test("an applied write remains successful while all projection readbacks settle", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: { setColorSchemaValues: BRANDING_PROFILE },
    });
    let finishRead!: () => void;
    apiMocks.revalidate.mockImplementation((query) =>
      query === adminThemeCatalogQuery
        ? Promise.reject(new Error("catalog readback unavailable"))
        : new Promise<void>((resolve) => {
            finishRead = resolve;
          }),
    );
    const { result } = renderHook(() => useSetColorSchemaValuesMutation());
    let acknowledged = false;
    const saving = result.current
      .setColorSchemaValues({ workspaceId: "workspace-1", colors: [] })
      .then((profile) => {
        acknowledged = true;
        return profile;
      });
    await act(async () => {
      await Promise.resolve();
    });
    expect(acknowledged).toBe(false);
    expect(apiMocks.reloadRuntimeTheme).not.toHaveBeenCalled();
    await act(async () => {
      finishRead();
      expect(await saving).toBe(BRANDING_PROFILE);
    });
    expect(acknowledged).toBe(true);
    expect(apiMocks.trigger).toHaveBeenCalledOnce();
    expect(apiMocks.reloadRuntimeTheme).toHaveBeenCalledOnce();
  });
});
