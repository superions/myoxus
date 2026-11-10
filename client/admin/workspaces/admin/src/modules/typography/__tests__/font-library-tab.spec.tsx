import type { ReactElement } from "react";
import type { ThemeFontFamily } from "../../theme/theme-contract";
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { PdfFontLicenseStatusEnum } from "@myoxus/graphql";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const fontAddonApiMocks = vi.hoisted(() => ({
  useFontAddonsQuery: vi.fn(),
  useFontAddonQuery: vi.fn(),
  useApproveFontAddonMutation: vi.fn(),
  useDeleteFontAddonMutation: vi.fn(),
  useRejectFontAddonMutation: vi.fn(),
  useUploadFontAddonMutation: vi.fn(),
  approveFontAddon: vi.fn(),
  deleteFontAddon: vi.fn(),
  rejectFontAddon: vi.fn(),
  uploadFontAddon: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () =>
      en["com.myoxus.peek-view-controls.close"],
    t: (key: string): string => en[key] ?? key,
    language: "en",
  }),
}));

vi.mock("../../theme/font-addons-api", () => ({
  useFontAddonsQuery: fontAddonApiMocks.useFontAddonsQuery,
  useFontAddonQuery: fontAddonApiMocks.useFontAddonQuery,
  useApproveFontAddonMutation: fontAddonApiMocks.useApproveFontAddonMutation,
  useDeleteFontAddonMutation: fontAddonApiMocks.useDeleteFontAddonMutation,
  useRejectFontAddonMutation: fontAddonApiMocks.useRejectFontAddonMutation,
  useUploadFontAddonMutation: fontAddonApiMocks.useUploadFontAddonMutation,
}));

import { FontLibraryTab } from "../font-library-tab";

function asset(
  usage: "web" | "pdf",
  format: "woff2" | "ttf",
  weightMin = 400,
  weightMax = 700,
) {
  return {
    usage,
    format,
    style: "normal",
    weightMin,
    weightMax,
    weightDefault: weightMin,
    assetKey: `${usage}-${format}-${weightMin}`,
    sha256: `${usage}${format}${weightMin}`,
    mime: format === "ttf" ? "font/ttf" : "font/woff2",
    unicodeRanges: ["latin"],
    subsetTags: ["latin"],
  };
}

const FAMILIES: ThemeFontFamily[] = [
  {
    slug: "bundled-ready",
    displayName: "Bundled Ready",
    cssFamily: "Bundled Ready",
    genericClass: "sans-serif",
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable: true,
    assets: [asset("web", "woff2"), asset("pdf", "ttf")],
  },
  {
    slug: "uploaded-pending",
    displayName: "Uploaded Pending",
    cssFamily: "Uploaded Pending",
    genericClass: "serif",
    source: "uploaded",
    licenseSpdx: "LicenseRef-Review",
    licenseStatus: "pending",
    isSelectable: false,
    assets: [asset("web", "woff2"), asset("pdf", "ttf")],
  },
  {
    slug: "missing-pdf",
    displayName: "Missing PDF",
    cssFamily: "Missing PDF",
    genericClass: "monospace",
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable: true,
    assets: [asset("web", "woff2")],
  },
  {
    slug: "rejected-upload",
    displayName: "Rejected Upload",
    cssFamily: "Rejected Upload",
    genericClass: "serif",
    source: "uploaded",
    licenseSpdx: "LicenseRef-Rejected",
    licenseStatus: "rejected",
    isSelectable: false,
    assets: [asset("web", "woff2"), asset("pdf", "ttf")],
  },
];

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

beforeEach(() => {
  fontAddonApiMocks.mutate.mockReset();
  fontAddonApiMocks.approveFontAddon.mockReset();
  fontAddonApiMocks.deleteFontAddon.mockReset();
  fontAddonApiMocks.rejectFontAddon.mockReset();
  fontAddonApiMocks.uploadFontAddon.mockReset();
  fontAddonApiMocks.useFontAddonsQuery.mockReturnValue({
    fontAddons: [],
    isLoading: false,
    error: null,
    mutate: fontAddonApiMocks.mutate,
  });
  fontAddonApiMocks.useFontAddonQuery.mockReturnValue({
    fontAddon: null,
    isLoading: false,
    error: null,
  });
  fontAddonApiMocks.useApproveFontAddonMutation.mockReturnValue({
    approveFontAddon: fontAddonApiMocks.approveFontAddon,
    isMutating: false,
  });
  fontAddonApiMocks.useDeleteFontAddonMutation.mockReturnValue({
    deleteFontAddon: fontAddonApiMocks.deleteFontAddon,
    isMutating: false,
  });
  fontAddonApiMocks.useRejectFontAddonMutation.mockReturnValue({
    rejectFontAddon: fontAddonApiMocks.rejectFontAddon,
    isMutating: false,
  });
  fontAddonApiMocks.useUploadFontAddonMutation.mockReturnValue({
    uploadFontAddon: fontAddonApiMocks.uploadFontAddon,
    isMutating: false,
  });
});

afterEach(cleanup);

describe("FontLibraryTab", () => {
  test("renders server catalog families with source, license and asset state", () => {
    renderWithProvider(<FontLibraryTab fontFamilies={FAMILIES} />);

    expect(
      screen.getByTestId("font-library-summary-total").textContent,
    ).toContain("4");
    expect(
      screen.getByTestId("font-library-summary-ready").textContent,
    ).toContain("1");
    expect(
      screen.getByTestId("font-library-summary-bundled").textContent,
    ).toContain("2");
    expect(
      screen.getByTestId("font-library-summary-uploaded").textContent,
    ).toContain("2");

    expect(
      screen.getByTestId("font-library-family-bundled-ready").textContent,
    ).toContain(en["admin.typography.font-library.status.ready"]!);
    expect(
      screen.getByTestId("font-library-family-uploaded-pending").textContent,
    ).toContain(en["admin.typography.font-library.status.blocked"]!);
    expect(
      screen.getByTestId("font-library-family-missing-pdf").textContent,
    ).toContain(en["admin.typography.font-library.status.incomplete"]!);
    expect(
      screen.getByTestId("font-library-family-rejected-upload").textContent,
    ).toContain(en["admin.typography.font-library.status.blocked"]!);
  });

  test("searches the loaded catalog without changing its totals or upload access", async () => {
    renderWithProvider(<FontLibraryTab fontFamilies={FAMILIES} />);
    const search = screen.getByRole("textbox", {
      name: en[
        "com.myoxus.settings.editorSettings.general.font-family.search.placeholder"
      ],
    });
    fireEvent.change(search, { target: { value: " MISSING-PDF " } });
    expect(
      screen.getByTestId("font-library-family-missing-pdf"),
    ).not.toBeNull();
    expect(
      screen.queryByTestId("font-library-family-bundled-ready"),
    ).toBeNull();
    expect(
      screen.getByTestId("font-library-summary-total").textContent,
    ).toContain("4");
    fireEvent.click(
      screen.getByRole("button", { name: en["admin.actions.clear"] }),
    );
    expect(
      screen.getByTestId("font-library-family-bundled-ready"),
    ).not.toBeNull();
    fireEvent.change(search, { target: { value: "no matching family" } });
    expect(
      screen.getByText(en["admin.common.no-results-found"]!),
    ).not.toBeNull();
    fireEvent.click(screen.getByTestId("font-addons-upload-open"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getByTestId("font-addons-upload-submit")
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("button", { name: en["admin.common.cancel"] }),
    );
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect((search as HTMLInputElement).value).toBe("no matching family");
    fireEvent.click(
      screen.getByRole("button", { name: en["admin.actions.refresh"] }),
    );
    expect(fontAddonApiMocks.mutate).toHaveBeenCalledTimes(1);
  });

  test("opens the add-on inspector directly from its family title", async () => {
    fontAddonApiMocks.useFontAddonsQuery.mockReturnValue({
      fontAddons: [
        {
          id: "uploaded-font",
          familyName: "Review Font",
          style: "normal",
          weight: 400,
          sha256: "a".repeat(64),
          license: "OFL-1.1",
          licenseStatus: PdfFontLicenseStatusEnum.Pending,
          uploadedBy: "Reviewer",
          uploadedAt: "2026-10-01T12:00:00Z",
          approvedBy: null,
          approvedAt: null,
        },
      ],
      isLoading: false,
      error: null,
      mutate: fontAddonApiMocks.mutate,
    });
    renderWithProvider(<FontLibraryTab fontFamilies={FAMILIES} />);
    fireEvent.click(screen.getByRole("button", { name: "Review Font" }));
    expect(fontAddonApiMocks.useFontAddonQuery).toHaveBeenLastCalledWith(
      "uploaded-font",
    );
    expect(
      await screen.findByText(
        en["admin.typography.font-addons.detail.unavailable"]!,
      ),
    ).not.toBeNull();
  });
});
