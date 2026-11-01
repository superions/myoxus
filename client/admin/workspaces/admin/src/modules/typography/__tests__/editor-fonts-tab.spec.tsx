import type { ReactElement } from "react";
import type { ThemeDefinition } from "../../theme/theme-contract";
import type { ThemeFontFamily } from "../../theme/theme-contract";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string): string => en[key] ?? key,
  }),
}));

import { EditorFontsTab } from "../editor-fonts-tab";

const THEME: ThemeDefinition = {
  slug: "atlas",
  name: "Atlas",
  origin: "system",
  locked: true,
  isDefault: true,
  colors: {},
  typographyStyles: [
    {
      styleKey: "page.title",
      fontFamilySlug: "libre-franklin",
      fontFamily: "Libre Franklin",
      cssFamily: "Libre Franklin",
      fontWeight: 700,
      sizePx: 36,
      lineHeight: 1.1,
      letterSpacingEm: -0.02,
      pdfRole: "heading",
    },
    {
      styleKey: "body.default",
      fontFamilySlug: "source-serif",
      fontFamily: "Source Serif 4",
      cssFamily: "Source Serif 4",
      fontWeight: 400,
      sizePx: 15,
      lineHeight: 1.55,
      letterSpacingEm: 0,
      pdfRole: "body",
    },
    {
      styleKey: "code.inline",
      fontFamilySlug: "jetbrains-mono",
      fontFamily: "JetBrains Mono",
      cssFamily: "JetBrains Mono",
      fontWeight: 500,
      sizePx: 13,
      lineHeight: 1.4,
      letterSpacingEm: 0,
      pdfRole: "mono",
    },
    {
      styleKey: "pdf.symbol",
      fontFamilySlug: "noto-symbols",
      fontFamily: "Noto Sans Symbols 2",
      cssFamily: "Noto Sans Symbols 2",
      fontWeight: 400,
      sizePx: 14,
      lineHeight: 1.3,
      letterSpacingEm: 0,
      pdfRole: "symbol",
    },
  ],
};

const FONT_FAMILIES: ThemeFontFamily[] = [
  {
    slug: "libre-franklin",
    displayName: "Libre Franklin",
    cssFamily: "Libre Franklin",
    genericClass: "sans-serif",
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable: true,
    assets: [
      {
        usage: "web",
        format: "woff2",
        style: "normal",
        weightMin: 400,
        weightMax: 900,
        weightDefault: 700,
        assetKey: "lf-web",
        sha256: "a",
        mime: "font/woff2",
        unicodeRanges: ["latin"],
        subsetTags: ["latin"],
      },
      {
        usage: "pdf",
        format: "ttf",
        style: "normal",
        weightMin: 400,
        weightMax: 900,
        weightDefault: 700,
        assetKey: "lf-ttf",
        sha256: "b",
        mime: "font/ttf",
        unicodeRanges: ["latin"],
        subsetTags: ["latin"],
      },
    ],
  },
  {
    slug: "source-serif",
    displayName: "Source Serif 4",
    cssFamily: "Source Serif 4",
    genericClass: "serif",
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable: true,
    assets: [
      {
        usage: "web",
        format: "woff2",
        style: "normal",
        weightMin: 400,
        weightMax: 700,
        weightDefault: 400,
        assetKey: "ss-web",
        sha256: "c",
        mime: "font/woff2",
        unicodeRanges: ["latin"],
        subsetTags: ["latin"],
      },
      {
        usage: "pdf",
        format: "ttf",
        style: "normal",
        weightMin: 400,
        weightMax: 700,
        weightDefault: 400,
        assetKey: "ss-ttf",
        sha256: "d",
        mime: "font/ttf",
        unicodeRanges: ["latin"],
        subsetTags: ["latin"],
      },
    ],
  },
  {
    slug: "noto-symbols",
    displayName: "Noto Sans Symbols 2",
    cssFamily: "Noto Sans Symbols 2",
    genericClass: "symbol",
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable: true,
    assets: [
      {
        usage: "web",
        format: "woff2",
        style: "normal",
        weightMin: 400,
        weightMax: 400,
        weightDefault: 400,
        assetKey: "ns-web",
        sha256: "e",
        mime: "font/woff2",
        unicodeRanges: ["symbols"],
        subsetTags: ["symbols"],
      },
    ],
  },
];

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("EditorFontsTab", () => {
  afterEach(cleanup);

  test("inv_asset_status_requires_web_and_pdf_assets", () => {
    renderWithProvider(
      <EditorFontsTab theme={THEME} fontFamilies={FONT_FAMILIES} />,
    );

    expect(
      screen.getByTestId("editor-fonts-role-heading").textContent,
    ).toContain(en["admin.typography.editor-fonts.asset.ready"]!);
    expect(screen.getByTestId("editor-fonts-role-body").textContent).toContain(
      en["admin.typography.editor-fonts.asset.ready"]!,
    );
    expect(
      screen.getByTestId("editor-fonts-role-symbol").textContent,
    ).toContain(en["admin.typography.editor-fonts.asset.incomplete"]!);
  });
});
