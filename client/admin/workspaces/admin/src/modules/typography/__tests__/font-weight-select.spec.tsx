import type { ReactElement } from "react";
import type { ThemeFontAsset } from "../../theme/theme-contract";
import type { ThemeFontFamily } from "../../theme/theme-contract";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

import { FontWeightSelect } from "../font-weight-select";
import { selectMantineOption } from "../../../__tests__/test-utils";

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

function family(displayName: string, weights: number[]): ThemeFontFamily {
  return {
    slug: displayName.toLowerCase().replace(/\s+/g, "-"),
    displayName,
    cssFamily: displayName,
    genericClass: "sans-serif",
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable: true,
    assets: weights.map(webAsset),
  };
}

const FONT_FAMILIES = [
  family("Catalog Sans", [400, 600, 700]),
  family("Catalog Serif", [400, 500, 700]),
];

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

afterEach(() => cleanup());

describe("FontWeightSelect", () => {
  test("selecting a native option emits the numeric weight", () => {
    const onChange = vi.fn();
    renderWithFacade(
      <FontWeightSelect
        family="Catalog Sans"
        value={400}
        onChange={onChange}
        fontFamilies={FONT_FAMILIES}
      />,
    );

    selectMantineOption(screen.getByTestId("font-weight-select"), "700 Bold");
    expect(onChange).toHaveBeenCalledWith(700);
  });
});
