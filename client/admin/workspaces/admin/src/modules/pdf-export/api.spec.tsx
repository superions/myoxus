/**
 * @vitest-environment happy-dom
 */
import {
  adminDocumentBrandingProfileQuery,
  adminPdfExportSettingsQuery,
  adminPdfTemplateQuery,
  adminPdfTemplatesQuery,
  adminPdfTemplateFilesQuery,
  adminPdfTemplatePreviewPdfQuery,
  adminPdfWorkspaceAssignmentsQuery,
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
  useQuery: vi.fn(() => ({ data: { admin: {} } })),
}));

import { useMutation } from "../../use-mutation";

import {
  useReplacePdfTemplateBundleMutation,
  useResetWorkspaceDocumentBrandingMutation,
  useSetWorkspaceDefaultPdfTemplateMutation,
  useUpdateDocumentBrandingColorsMutation,
  useUpdatePdfExportSettingsMutation,
} from "./api";

function predicateFor(query: unknown) {
  const call = apiMocks.revalidate.mock.calls.find(
    ([candidate, predicate]) =>
      candidate === query && typeof predicate === "function",
  );
  expect(call).toBeTruthy();
  return call?.[1] as (vars?: { workspaceId?: string | null }) => boolean;
}

describe("pdf-export api cache boundaries", () => {
  beforeEach(() => {
    apiMocks.trigger.mockReset();
    apiMocks.revalidate.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("replacement refreshes the catalog and only the replaced bundle consumers", async () => {
    renderHook(() => useReplacePdfTemplateBundleMutation());
    const configuration = vi.mocked(useMutation).mock.calls.at(-1)?.[1];
    if (!configuration?.onSuccess)
      throw new Error("Missing replacement invalidation");
    const onSuccess = configuration.onSuccess as (result: {
      admin: { replacePdfTemplateBundle: { id: string } };
    }) => Promise<void>;
    await act(async () => {
      await onSuccess({
        admin: { replacePdfTemplateBundle: { id: "tpl-1" } },
      });
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminPdfTemplatesQuery);
    for (const query of [
      adminPdfTemplateFilesQuery,
      adminPdfTemplatePreviewPdfQuery,
    ]) {
      const call = apiMocks.revalidate.mock.calls.find(
        ([candidate]) => candidate === query,
      );
      expect(call?.[2]).toEqual({ clearCachedData: true });
      const predicate = call?.[1];
      expect(predicate({ templateId: "tpl-1" })).toBe(true);
      expect(predicate({ templateId: "tpl-2" })).toBe(false);
    }
    const detail = apiMocks.revalidate.mock.calls.find(
      ([query]) => query === adminPdfTemplateQuery,
    )?.[1];
    expect(detail({ id: "tpl-1" })).toBe(true);
    expect(detail({ id: "tpl-2" })).toBe(false);
    expect(apiMocks.revalidate).toHaveBeenCalledTimes(4);
  });

  test("document branding color updates revalidate only document branding profile", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        updateDocumentBrandingColors: {
          workspaceId: "ws-1",
          brandColorPrimary: "#112233",
          brandColorAccent: "#445566",
        },
      },
    });

    const { result } = renderHook(() =>
      useUpdateDocumentBrandingColorsMutation(),
    );
    await act(async () => {
      await result.current.updateDocumentBrandingColors({
        workspaceId: "ws-1",
        primary: "#112233",
        accent: "#445566",
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      primary: "#112233",
      accent: "#445566",
    });
    const shouldRevalidate = predicateFor(adminDocumentBrandingProfileQuery);
    expect(shouldRevalidate({ workspaceId: "ws-1" })).toBe(true);
    expect(shouldRevalidate({ workspaceId: "ws-2" })).toBe(false);
    expect(apiMocks.revalidate).not.toHaveBeenCalledWith(
      adminPdfExportSettingsQuery,
      expect.any(Function),
    );
  });

  test("PDF export settings updates revalidate only PDF export settings", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        updatePdfExportSettings: {
          workspaceId: "ws-1",
          defaultPaperSize: "A4",
        },
      },
    });

    const { result } = renderHook(() => useUpdatePdfExportSettingsMutation());
    await act(async () => {
      await result.current.updatePdfExportSettings({
        workspaceId: "ws-1",
        paperSize: "A4",
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      paperSize: "A4",
    });
    const shouldRevalidate = predicateFor(adminPdfExportSettingsQuery);
    expect(shouldRevalidate({ workspaceId: "ws-1" })).toBe(true);
    expect(shouldRevalidate({ workspaceId: "ws-2" })).toBe(false);
    expect(apiMocks.revalidate).not.toHaveBeenCalledWith(
      adminDocumentBrandingProfileQuery,
      expect.any(Function),
    );
  });

  test("document branding reset revalidates only document branding profile", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        resetWorkspaceDocumentBranding: {
          workspaceId: "ws-1",
        },
      },
    });

    const { result } = renderHook(() =>
      useResetWorkspaceDocumentBrandingMutation(),
    );
    await act(async () => {
      await result.current.resetWorkspaceDocumentBranding({
        workspaceId: "ws-1",
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({ workspaceId: "ws-1" });
    const shouldRevalidate = predicateFor(adminDocumentBrandingProfileQuery);
    expect(shouldRevalidate({ workspaceId: "ws-1" })).toBe(true);
    expect(shouldRevalidate({ workspaceId: "ws-2" })).toBe(false);
    expect(apiMocks.revalidate).not.toHaveBeenCalledWith(
      adminPdfExportSettingsQuery,
      expect.any(Function),
    );
  });

  test("default template updates revalidate PDF settings and assignments", async () => {
    apiMocks.trigger.mockResolvedValue({
      admin: {
        setWorkspaceDefaultPdfTemplate: {
          workspaceId: "ws-1",
          defaultTemplateId: "tpl-1",
        },
      },
    });

    const { result } = renderHook(() =>
      useSetWorkspaceDefaultPdfTemplateMutation(),
    );
    await act(async () => {
      await result.current.setWorkspaceDefaultPdfTemplate({
        workspaceId: "ws-1",
        templateId: "tpl-1",
      });
    });

    expect(apiMocks.trigger).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      templateId: "tpl-1",
    });
    expect(
      predicateFor(adminPdfExportSettingsQuery)({ workspaceId: "ws-1" }),
    ).toBe(true);
    expect(
      predicateFor(adminPdfWorkspaceAssignmentsQuery)({ workspaceId: "ws-1" }),
    ).toBe(true);
    expect(apiMocks.revalidate).not.toHaveBeenCalledWith(
      adminDocumentBrandingProfileQuery,
      expect.any(Function),
    );
  });
});
