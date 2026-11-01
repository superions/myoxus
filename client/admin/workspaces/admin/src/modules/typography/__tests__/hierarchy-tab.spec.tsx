import type { ReactElement } from "react";
import type { ThemeDefinition } from "../../theme/theme-contract";
import type { ThemeFontAsset } from "../../theme/theme-contract";
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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";
import { selectMantineOption } from "../../../__tests__/test-utils";

const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string): string => en[key] ?? key,
  }),
}));

vi.mock("../../header", () => ({
  Header: ({ title, endFix }: { title: string; endFix?: React.ReactNode }) => (
    <div data-testid="header">
      <span data-testid="header-title">{title}</span>
      {endFix ? <div data-testid="header-endfix">{endFix}</div> : null}
    </div>
  ),
}));

const useThemeCatalogQueryMock = vi.fn();
const useEffectiveThemeProfileQueryMock = vi.fn();
const setTypographyStylesMock = vi.fn();
const fontAddonApiMocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  approveFontAddon: vi.fn(),
  deleteFontAddon: vi.fn(),
  rejectFontAddon: vi.fn(),
  uploadFontAddon: vi.fn(),
}));

vi.mock("../../theme/theme-api", () => ({
  useThemeCatalogQuery: () => useThemeCatalogQueryMock(),
  useEffectiveThemeProfileQuery: (workspaceId?: string | null) =>
    useEffectiveThemeProfileQueryMock(workspaceId),
  useSetTypographyStylesMutation: () => ({
    setTypographyStyles: setTypographyStylesMock,
    isMutating: false,
  }),
}));

vi.mock("../../theme/font-addons-api", () => ({
  useFontAddonsQuery: () => ({
    fontAddons: [],
    isLoading: false,
    error: null,
    mutate: fontAddonApiMocks.mutate,
  }),
  useFontAddonQuery: () => ({
    fontAddon: null,
    isLoading: false,
    error: null,
  }),
  useApproveFontAddonMutation: () => ({
    approveFontAddon: fontAddonApiMocks.approveFontAddon,
    isMutating: false,
  }),
  useDeleteFontAddonMutation: () => ({
    deleteFontAddon: fontAddonApiMocks.deleteFontAddon,
    isMutating: false,
  }),
  useRejectFontAddonMutation: () => ({
    rejectFontAddon: fontAddonApiMocks.rejectFontAddon,
    isMutating: false,
  }),
  useUploadFontAddonMutation: () => ({
    uploadFontAddon: fontAddonApiMocks.uploadFontAddon,
    isMutating: false,
  }),
}));

import { TypographyPage } from "../index";
import { ScopedTypographyEditor } from "../scoped-typography-editor";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

function webAsset(weight: number): ThemeFontAsset {
  return {
    usage: "web",
    format: "woff2",
    style: "normal",
    weightMin: weight,
    weightMax: weight,
    weightDefault: weight,
    assetKey: `${weight}.woff2`,
    sha256: String(weight),
    mime: "font/woff2",
    unicodeRanges: ["latin"],
    subsetTags: ["latin"],
  };
}

function fontFamily(
  slug: string,
  displayName: string,
  genericClass: string,
  weights: number[],
): ThemeFontFamily {
  return {
    slug,
    displayName,
    cssFamily: displayName,
    genericClass,
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable: true,
    assets: weights.map(webAsset),
  };
}

const FONT_FAMILIES = [
  fontFamily("catalog-serif", "Catalog Serif", "serif", [400, 700]),
  fontFamily("catalog-sans", "Catalog Sans", "sans-serif", [400, 600, 700]),
  fontFamily("catalog-mono", "Catalog Mono", "monospace", [400, 500]),
];

const THEME: ThemeDefinition = {
  slug: "catalog-serif",
  name: "Catalog Serif Theme",
  origin: "system",
  locked: true,
  isDefault: true,
  colorSchemaSlug: "catalog-light",
  typographySlug: "serif-profile",
  colors: {},
  typographyStyles: [
    {
      styleKey: "heading.h1",
      fontFamilySlug: "catalog-serif",
      fontFamily: "Catalog Serif",
      fontWeight: 700,
      sizePx: 48,
      lineHeight: 1.1,
      letterSpacingEm: -0.03,
    },
    {
      styleKey: "heading.h2",
      fontFamilySlug: "catalog-serif",
      fontFamily: "Catalog Serif",
      fontWeight: 700,
      sizePx: 36,
      lineHeight: 1.15,
      letterSpacingEm: -0.02,
    },
    {
      styleKey: "body.default",
      fontFamilySlug: "catalog-sans",
      fontFamily: "Catalog Sans",
      fontWeight: 400,
      sizePx: 17,
      lineHeight: 1.6,
      letterSpacingEm: 0.01,
    },
    {
      styleKey: "link.default",
      fontFamilySlug: "catalog-sans",
      fontFamily: "Catalog Sans",
      fontWeight: 600,
      decoration: "underline",
      hoverDecoration: "none",
    },
    {
      styleKey: "code.inline",
      fontFamilySlug: "catalog-mono",
      fontFamily: "Catalog Mono",
      fontWeight: 500,
      sizePx: 14,
    },
    {
      styleKey: "pdf.body",
      fontFamilySlug: "catalog-sans",
      fontFamily: "Catalog Sans",
      fontWeight: 400,
      sizePx: 11,
      lineHeight: 1.4,
      pdfRole: "body",
      fontFeatures: { liga: true },
      fontVariations: { opsz: 14 },
    },
  ],
};

beforeEach(() => {
  window.history.pushState({}, "", "/adminfrontend/typography?tab=hierarchy");
  useThemeCatalogQueryMock.mockReturnValue({
    themes: [THEME],
    fontFamilies: FONT_FAMILIES,
    catalog: { themes: [THEME], fontFamilies: FONT_FAMILIES },
  });
  useEffectiveThemeProfileQueryMock.mockReturnValue({
    profile: {
      scope: "global",
      workspaceId: null,
      themeMode: "system",
      theme: THEME,
    },
  });
});

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/adminfrontend/typography?tab=hierarchy");
  useThemeCatalogQueryMock.mockReset();
  useEffectiveThemeProfileQueryMock.mockReset();
  setTypographyStylesMock.mockReset();
  fontAddonApiMocks.mutate.mockReset();
  fontAddonApiMocks.approveFontAddon.mockReset();
  fontAddonApiMocks.deleteFontAddon.mockReset();
  fontAddonApiMocks.rejectFontAddon.mockReset();
  fontAddonApiMocks.uploadFontAddon.mockReset();
});

describe("HierarchyTab via TypographyPage", () => {
  const openStyleEditor = async (styleKey: string) => {
    const item = screen.getByTestId(`typography-style-editor-${styleKey}`);
    const control = within(item).getByRole("button");
    fireEvent.click(control);
    await waitFor(() =>
      expect(control.getAttribute("aria-expanded")).toBe("true"),
    );
  };

  test("renders body typography previews as long copy instead of hierarchy pangrams", () => {
    window.history.pushState({}, "", "/adminfrontend/typography?tab=body");
    renderWithFacade(<TypographyPage />);

    const pangram = en["admin.typography.preview.pangram"]!;
    const bodyPreview = screen.getByTestId("body-body-preview");
    const bodySmallPreview = screen.getByTestId("body-bodySmall-preview");
    const quotePreview = screen.getByTestId("body-blockquote-preview");
    const bodyLineKeys = [
      "admin.typography.preview.body.line-1",
      "admin.typography.preview.body.line-2",
      "admin.typography.preview.body.line-3",
      "admin.typography.preview.body.line-4",
    ] as const;
    const bodySmallLineKeys = [
      "admin.typography.preview.body-small.line-1",
      "admin.typography.preview.body-small.line-2",
      "admin.typography.preview.body-small.line-3",
      "admin.typography.preview.body-small.line-4",
    ] as const;
    const quoteLineKeys = [
      "admin.typography.preview.blockquote.line-1",
      "admin.typography.preview.blockquote.line-2",
      "admin.typography.preview.blockquote.line-3",
      "admin.typography.preview.blockquote.line-4",
    ] as const;

    expect(bodyPreview.textContent).not.toContain(pangram);
    expect(bodySmallPreview.textContent).not.toContain(pangram);
    expect(quotePreview.textContent).not.toContain(pangram);
    expect(screen.getAllByTestId("body-body-preview-line")).toHaveLength(4);
    expect(screen.getAllByTestId("body-bodySmall-preview-line")).toHaveLength(
      4,
    );
    expect(screen.getAllByTestId("body-blockquote-preview-line")).toHaveLength(
      4,
    );
    for (const key of bodyLineKeys) {
      expect(bodyPreview.textContent).toContain(en[key]!);
    }
    for (const key of bodySmallLineKeys) {
      expect(bodySmallPreview.textContent).toContain(en[key]!);
    }
    for (const key of quoteLineKeys) {
      expect(quotePreview.textContent).toContain(en[key]!);
    }

    const codeBlock = screen.getByTestId("body-code-block-preview");
    expect(codeBlock.tagName).toBe("PRE");
    expect(codeBlock.getAttribute("data-variant")).toBe("block");
    expect(codeBlock.textContent?.split("\n")).toHaveLength(4);
  });

  test("saves typed typography style patches through AdminRoot", async () => {
    setTypographyStylesMock.mockResolvedValue({
      scope: "global",
      workspaceId: null,
      themeMode: "system",
      theme: THEME,
    });
    renderWithFacade(<TypographyPage />);
    const saveButton = screen.getByTestId(
      "typography-save",
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    fireEvent.input(screen.getByTestId("hierarchy-h1-size"), {
      target: { value: "52" },
    });
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(setTypographyStylesMock).toHaveBeenCalledOnce());
    expect(setTypographyStylesMock).toHaveBeenCalledWith({
      workspaceId: null,
      styles: expect.arrayContaining([
        expect.objectContaining({
          styleKey: "heading.h1",
          fontFamilySlug: "catalog-serif",
          fontWeight: 700,
          sizePx: 52,
          lineHeight: 1.1,
          letterSpacingEm: -0.03,
        }),
      ]),
    });
    expect(screen.queryByTestId("typography-discard")).toBeNull();
  });

  test("disables save again when a draft value returns to the server value", () => {
    renderWithFacade(<TypographyPage />);
    const saveButton = screen.getByTestId(
      "typography-save",
    ) as HTMLButtonElement;
    const sizeInput = screen.getByTestId(
      "hierarchy-h1-size",
    ) as HTMLInputElement;

    fireEvent.input(sizeInput, { target: { value: "52" } });
    expect(saveButton.disabled).toBe(false);
    fireEvent.input(sizeInput, { target: { value: "48" } });
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(saveButton);
    expect(setTypographyStylesMock).not.toHaveBeenCalled();
  });

  test("keeps the draft editable and visible when the server rejects save", async () => {
    setTypographyStylesMock.mockRejectedValue(
      new Error("validation failed: font family does not provide pdf asset"),
    );
    renderWithFacade(<TypographyPage />);
    const saveButton = screen.getByTestId(
      "typography-save",
    ) as HTMLButtonElement;

    fireEvent.input(screen.getByTestId("hierarchy-h1-size"), {
      target: { value: "52" },
    });
    fireEvent.click(saveButton);

    await waitFor(() => expect(setTypographyStylesMock).toHaveBeenCalledOnce());
    const alert = screen.getByTestId("typography-save-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("validation failed");
    expect(saveButton.disabled).toBe(false);
    expect(
      (screen.getByTestId("hierarchy-h1-size") as HTMLInputElement).value,
    ).toBe("52");
  });

  test("falls back to the default catalog theme when no effective profile exists", () => {
    useEffectiveThemeProfileQueryMock.mockReturnValue({
      profile: undefined,
    });

    renderWithFacade(<TypographyPage />);

    expect(useEffectiveThemeProfileQueryMock).toHaveBeenCalledWith(null);
    expect(
      (screen.getByTestId("hierarchy-h1-size") as HTMLInputElement).value,
    ).toBe("48");
  });

  test("renders and saves every server style key in the generic styles tab", async () => {
    setTypographyStylesMock.mockResolvedValue({
      scope: "global",
      workspaceId: null,
      themeMode: "system",
      theme: THEME,
    });
    window.history.pushState({}, "", "/adminfrontend/typography?tab=styles");
    renderWithFacade(<TypographyPage />);

    expect(screen.getByTestId("typography-style-editor-pdf.body")).toBeTruthy();
    await openStyleEditor("pdf.body");

    fireEvent.input(screen.getByTestId("pdf.body-size"), {
      target: { value: "12" },
    });
    selectMantineOption(screen.getByTestId("pdf.body-pdf-role"), "symbol");
    fireEvent.input(screen.getByTestId("pdf.body-features"), {
      target: { value: '{ "liga": false }' },
    });

    fireEvent.click(screen.getByTestId("typography-styles-save"));

    await waitFor(() => expect(setTypographyStylesMock).toHaveBeenCalledOnce());
    expect(setTypographyStylesMock).toHaveBeenCalledWith({
      workspaceId: null,
      styles: expect.arrayContaining([
        expect.objectContaining({
          styleKey: "pdf.body",
          fontFamilySlug: "catalog-sans",
          fontWeight: 400,
          sizePx: 12,
          lineHeight: 1.4,
          pdfRole: "symbol",
          fontFeatures: { liga: false },
          fontVariations: { opsz: 14 },
        }),
      ]),
    });
  });

  test("keeps unsaved token drafts after saving generic style rows", async () => {
    setTypographyStylesMock.mockResolvedValue({
      scope: "global",
      workspaceId: null,
      themeMode: "system",
      theme: THEME,
    });
    window.history.pushState({}, "", "/adminfrontend/typography?tab=hierarchy");
    renderWithFacade(<TypographyPage />);

    fireEvent.input(screen.getByTestId("hierarchy-h1-size"), {
      target: { value: "52" },
    });
    expect(
      (screen.getByTestId("typography-save") as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("typography-tab-styles"));
    expect(screen.queryByTestId("typography-save")).toBeNull();
    await openStyleEditor("pdf.body");
    fireEvent.input(screen.getByTestId("pdf.body-size"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByTestId("typography-styles-save"));

    await waitFor(() => expect(setTypographyStylesMock).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByTestId("typography-tab-hierarchy"));
    expect(
      (screen.getByTestId("hierarchy-h1-size") as HTMLInputElement).value,
    ).toBe("52");
    expect(
      (screen.getByTestId("typography-save") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("filters large generic style-key sets without dropping server rows", () => {
    window.history.pushState({}, "", "/adminfrontend/typography?tab=styles");
    renderWithFacade(<TypographyPage />);

    expect(
      screen.getByTestId("typography-style-editor-heading.h1"),
    ).toBeTruthy();
    expect(screen.getByTestId("typography-style-editor-pdf.body")).toBeTruthy();

    fireEvent.input(screen.getByTestId("typography-styles-filter"), {
      target: { value: "pdf" },
    });

    expect(
      screen.queryByTestId("typography-style-editor-heading.h1"),
    ).toBeNull();
    expect(screen.getByTestId("typography-style-editor-pdf.body")).toBeTruthy();
  });

  test("blocks generic style saves with invalid JSON before mutating AdminRoot", async () => {
    setTypographyStylesMock.mockResolvedValue({
      scope: "global",
      workspaceId: null,
      themeMode: "system",
      theme: THEME,
    });
    window.history.pushState({}, "", "/adminfrontend/typography?tab=styles");
    renderWithFacade(<TypographyPage />);

    await openStyleEditor("pdf.body");
    fireEvent.input(screen.getByTestId("pdf.body-features"), {
      target: { value: "{" },
    });
    fireEvent.click(screen.getByTestId("typography-styles-save"));

    expect(screen.getByTestId("pdf.body-validation-errors")).toBeTruthy();
    expect(setTypographyStylesMock).not.toHaveBeenCalled();

    fireEvent.input(screen.getByTestId("pdf.body-features"), {
      target: { value: "{}" },
    });
    fireEvent.click(screen.getByTestId("typography-styles-save"));

    await waitFor(() => expect(setTypographyStylesMock).toHaveBeenCalledOnce());
  }, 10_000);

  test("rebases changed server values without losing dirty tokens and resets to the latest readback", () => {
    const { rerender } = renderWithFacade(<TypographyPage />);
    fireEvent.input(screen.getByTestId("hierarchy-h1-size"), {
      target: { value: "52" },
    });
    const changedTheme = {
      ...THEME,
      typographyStyles: THEME.typographyStyles?.map((style) =>
        style.styleKey === "heading.h1" ? { ...style, sizePx: 50 } : style,
      ),
    };
    useEffectiveThemeProfileQueryMock.mockReturnValue({
      profile: { theme: changedTheme },
    });
    rerender(
      <MyoxusUIProvider>
        <TypographyPage />
      </MyoxusUIProvider>,
    );
    expect(
      (screen.getByTestId("hierarchy-h1-size") as HTMLInputElement).value,
    ).toBe("52");
    fireEvent.click(screen.getByTestId("typography-discard"));
    expect(
      (screen.getByTestId("hierarchy-h1-size") as HTMLInputElement).value,
    ).toBe("50");
  });

  test("shares the workspace save guard and releases it only after typography readback", async () => {
    const onSaveStart = vi.fn(() => false);
    const onSaveEnd = vi.fn();
    let resolve!: (profile: unknown) => void;
    setTypographyStylesMock.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    renderWithFacade(
      <ScopedTypographyEditor
        layout="embedded"
        onSaveStart={onSaveStart}
        onSaveEnd={onSaveEnd}
      />,
    );
    fireEvent.input(screen.getByTestId("hierarchy-h1-size"), {
      target: { value: "52" },
    });
    fireEvent.click(screen.getByTestId("typography-save"));
    expect(setTypographyStylesMock).not.toHaveBeenCalled();
    expect(onSaveEnd).not.toHaveBeenCalled();
    expect(screen.getByTestId("hierarchy-h1-size")).toHaveProperty(
      "value",
      "52",
    );
    onSaveStart.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("typography-save"));
    expect(setTypographyStylesMock).toHaveBeenCalledOnce();
    expect(onSaveEnd).not.toHaveBeenCalled();
    resolve({ theme: THEME });
    await waitFor(() => expect(onSaveEnd).toHaveBeenCalledOnce());
    expect(screen.getByTestId("hierarchy-h1-size")).toHaveProperty(
      "value",
      "48",
    );
  });

  test("isolates retained workspace drafts and sends only the selected workspace scope", async () => {
    setTypographyStylesMock.mockResolvedValue({ theme: THEME });
    const { rerender } = renderWithFacade(
      <ScopedTypographyEditor
        workspaceId="workspace-alpha"
        layout="embedded"
      />,
    );
    fireEvent.input(screen.getByTestId("hierarchy-h1-size"), {
      target: { value: "52" },
    });
    rerender(
      <MyoxusUIProvider>
        <ScopedTypographyEditor
          workspaceId="workspace-beta"
          layout="embedded"
        />
      </MyoxusUIProvider>,
    );
    expect(
      (screen.getByTestId("hierarchy-h1-size") as HTMLInputElement).value,
    ).toBe("48");
    fireEvent.input(screen.getByTestId("hierarchy-h1-size"), {
      target: { value: "54" },
    });
    fireEvent.click(screen.getByTestId("typography-save"));
    await waitFor(() =>
      expect(setTypographyStylesMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "workspace-beta" }),
      ),
    );
    expect(setTypographyStylesMock).toHaveBeenCalledOnce();
  });

  test("keeps filtered generic drafts, failed writes and validation visible until explicit discard", async () => {
    window.history.pushState({}, "", "/adminfrontend/typography?tab=styles");
    setTypographyStylesMock.mockRejectedValue(
      new Error("QA rejected scoped styles"),
    );
    renderWithFacade(<TypographyPage />);
    await openStyleEditor("pdf.body");
    fireEvent.input(screen.getByTestId("pdf.body-size"), {
      target: { value: "12" },
    });
    fireEvent.input(screen.getByTestId("typography-styles-filter"), {
      target: { value: "heading" },
    });
    fireEvent.click(screen.getByTestId("typography-tab-presets"));
    fireEvent.click(screen.getByTestId("typography-tab-styles"));
    expect(
      (screen.getByTestId("typography-styles-filter") as HTMLInputElement)
        .value,
    ).toBe("heading");
    fireEvent.click(screen.getByTestId("typography-styles-save"));
    await waitFor(() =>
      expect(
        screen.getByTestId("typography-styles-error").textContent,
      ).toContain("QA rejected"),
    );
    fireEvent.input(screen.getByTestId("typography-styles-filter"), {
      target: { value: "pdf" },
    });
    expect(
      (screen.getByTestId("pdf.body-size") as HTMLInputElement).value,
    ).toBe("12");
    fireEvent.click(screen.getByTestId("typography-styles-discard"));
    expect(
      (screen.getByTestId("pdf.body-size") as HTMLInputElement).value,
    ).toBe("11");
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("typography-styles-filter"),
    );
    expect(screen.queryByTestId("typography-styles-error")).toBeNull();
  });

  test("does not enable typography writes when the authoritative font catalog is unavailable", () => {
    useThemeCatalogQueryMock.mockReturnValue({
      themes: [THEME],
      fontFamilies: [],
    });
    renderWithFacade(<TypographyPage />);
    expect(
      (screen.getByTestId("hierarchy-h1-size") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("typography-save") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(setTypographyStylesMock).not.toHaveBeenCalled();
  });
});
