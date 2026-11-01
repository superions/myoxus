/**
 * @vitest-environment happy-dom
 *
 * FontFamilySelect renders families from the server-owned Theme DB catalog.
 * It must not fetch `/api/fonts` or inject preview-only font faces.
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ThemeFontFamily } from "../../theme/theme-contract";
import { FontFamilySelect } from "../font-family-select";

function family(
  slug: string,
  displayName: string,
  genericClass = "sans-serif",
  isSelectable = true,
): ThemeFontFamily {
  return {
    slug,
    displayName,
    cssFamily: displayName,
    genericClass,
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable,
    assets: [
      {
        usage: "web",
        format: "woff2",
        style: "normal",
        weightMin: 400,
        weightMax: 700,
        weightDefault: 400,
        assetKey: `${slug}.woff2`,
        sha256: slug,
        mime: "font/woff2",
        unicodeRanges: ["latin"],
        subsetTags: ["latin"],
      },
    ],
  };
}

const FONT_FAMILIES = [
  family("catalog-sans", "Catalog Sans", "sans-serif"),
  family("catalog-serif", "Catalog Serif", "serif"),
  family("blocked", "Blocked Family", "serif", false),
];

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

function openCombobox() {
  const input = screen.getByTestId("font-family-trigger");
  fireEvent.click(input);
  return input as HTMLInputElement;
}

afterEach(cleanup);

describe("FontFamilySelect", () => {
  test("renders selectable catalog families inside the dropdown", () => {
    const onChange = vi.fn();
    renderWithFacade(
      <FontFamilySelect
        value="Catalog Sans"
        onChange={onChange}
        fontFamilies={FONT_FAMILIES}
      />,
    );

    const trigger = openCombobox();
    expect(trigger.value).toContain("Catalog Sans");

    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Catalog Sans" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Catalog Serif" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Blocked Family" })).toBeNull();
  });

  test("clicking an option emits onChange and closes the listbox", () => {
    const onChange = vi.fn();
    renderWithFacade(
      <FontFamilySelect
        value="Catalog Sans"
        onChange={onChange}
        fontFamilies={FONT_FAMILIES}
      />,
    );

    openCombobox();
    fireEvent.click(screen.getByRole("option", { name: "Catalog Serif" }));

    expect(onChange).toHaveBeenCalledWith("Catalog Serif");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("can filter entries while retaining the current trigger value", () => {
    const onChange = vi.fn();
    renderWithFacade(
      <FontFamilySelect
        value="Catalog Sans"
        onChange={onChange}
        fontFamilies={FONT_FAMILIES}
        filter={(entry) => entry.category === "serif"}
      />,
    );

    const trigger = openCombobox();
    expect(trigger.value).toContain("Catalog Sans");

    fireEvent.click(screen.getByRole("option", { name: "Catalog Sans" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Catalog Serif" })).toBeTruthy();
  });
});
