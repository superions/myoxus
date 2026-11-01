// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/** @vitest-environment happy-dom */
import {
  adminApprovePdfFontMutation,
  adminDeletePdfFontMutation,
  adminPdfFontQuery,
  adminPdfFontsQuery,
  adminRejectPdfFontMutation,
  adminThemeCatalogQuery,
  adminUploadPdfFontMutation,
} from "@myoxus/graphql";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  trigger: vi.fn(),
  revalidate: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("../../use-mutation", () => ({
  useMutation: apiMocks.useMutation,
  useMutateQueryResource: vi.fn(() => apiMocks.revalidate),
}));

vi.mock("../../use-query", () => ({
  useQuery: apiMocks.useQuery,
}));

import {
  useApproveFontAddonMutation,
  useDeleteFontAddonMutation,
  useRejectFontAddonMutation,
  useUploadFontAddonMutation,
} from "./font-addons-api";

function detailRevalidationPredicate() {
  const call = apiMocks.revalidate.mock.calls.find(
    ([query, predicate]) =>
      query === adminPdfFontQuery && typeof predicate === "function",
  );
  expect(call).toBeTruthy();
  return call?.[1] as (vars?: { id?: string | null }) => boolean;
}

describe("font-addons-api mutations", () => {
  beforeEach(() => {
    apiMocks.trigger.mockReset();
    apiMocks.revalidate.mockReset();
    apiMocks.useQuery.mockReset();
    apiMocks.useMutation.mockReset();
    apiMocks.useMutation.mockReturnValue({
      trigger: apiMocks.trigger,
      isMutating: false,
    });
  });

  test("upload uses uploadPdfFont and revalidates list, detail and theme catalog", async () => {
    const file = new File(["font"], "custom.ttf", { type: "font/ttf" });
    apiMocks.trigger.mockResolvedValue({
      admin: {
        uploadPdfFont: {
          id: "font-1",
        },
      },
    });

    const { result } = renderHook(() => useUploadFontAddonMutation());

    await act(async () => {
      await result.current.uploadFontAddon({ file, license: "OFL-1.1" });
    });

    expect(apiMocks.useMutation).toHaveBeenCalledWith({
      mutation: adminUploadPdfFontMutation,
    });
    expect(apiMocks.trigger).toHaveBeenCalledWith({
      file,
      license: "OFL-1.1",
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminPdfFontsQuery);
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminThemeCatalogQuery);
    expect(detailRevalidationPredicate()({ id: "font-1" })).toBe(true);
    expect(detailRevalidationPredicate()({ id: "other" })).toBe(false);
  });

  test("approve, reject and delete reuse the AdminRoot pdfFont lifecycle", async () => {
    apiMocks.trigger
      .mockResolvedValueOnce({
        admin: { approvePdfFont: { id: "font-1" } },
      })
      .mockResolvedValueOnce({
        admin: { rejectPdfFont: { id: "font-1" } },
      })
      .mockResolvedValueOnce({
        admin: { deletePdfFont: true },
      });

    const approve = renderHook(() => useApproveFontAddonMutation()).result;
    const reject = renderHook(() => useRejectFontAddonMutation()).result;
    const remove = renderHook(() => useDeleteFontAddonMutation()).result;

    await act(async () => {
      await approve.current.approveFontAddon("font-1");
      await reject.current.rejectFontAddon({
        id: "font-1",
        reason: "license does not allow embedding",
      });
      await remove.current.deleteFontAddon("font-1");
    });

    expect(apiMocks.useMutation).toHaveBeenCalledWith({
      mutation: adminApprovePdfFontMutation,
    });
    expect(apiMocks.useMutation).toHaveBeenCalledWith({
      mutation: adminRejectPdfFontMutation,
    });
    expect(apiMocks.useMutation).toHaveBeenCalledWith({
      mutation: adminDeletePdfFontMutation,
    });
    expect(apiMocks.trigger).toHaveBeenCalledWith({ id: "font-1" });
    expect(apiMocks.trigger).toHaveBeenCalledWith({
      id: "font-1",
      reason: "license does not allow embedding",
    });
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminPdfFontsQuery);
    expect(apiMocks.revalidate).toHaveBeenCalledWith(adminThemeCatalogQuery);
    expect(detailRevalidationPredicate()({ id: "font-1" })).toBe(true);
  });
});
