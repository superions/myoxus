// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { afterEach, expect, test, vi } from "vitest";
import { FontFamily, FontFamilySchema } from "@virgultum/editor/model";
import {
  getFontFamilies,
  getFontFamilyName,
  getFontStyles,
  supportsFontFace,
  wrapFontFamily,
} from "../../../../../../virgultum/editor/blocks/surface/src/utils/font";

const mounted: HTMLStyleElement[] = [];
afterEach(() => {
  mounted.splice(0).forEach((style) => style.remove());
  vi.restoreAllMocks();
});
function projection(css: string, branding = true) {
  const style = document.createElement("style");
  if (branding) style.dataset.myoxusBranding = "true";
  style.textContent = css;
  document.head.append(style);
  mounted.push(style);
  return style;
}

test("font choices follow the server projection without leaking renderer fonts", () => {
  projection(
    "@font-face { font-family: KaTeX_Main; src: url(math.woff2); }",
    false,
  );
  expect(getFontFamilies()).toEqual([]);
  const sheet = projection(
    '@font-face { font-family: "Fixture Display"; src: url(display.woff2); }',
  );
  expect(getFontFamilies()).toEqual(["Fixture Display"]);
  sheet.textContent +=
    '@font-face { font-family: "Fixture Serif"; src: url(serif.woff2); }';
  expect(getFontFamilies()).toEqual(["Fixture Display", "Fixture Serif"]);
});

test("variable font styles and new family names preserve existing document IDs", () => {
  const sheet = projection(
    '@font-face { font-family: "Fixture Display"; font-weight: 100 900; font-style: italic; src: url(display.woff2); } @font-face { font-family: "Fixture Display"; font-weight: 400; font-style: italic; src: url(display-subset.woff2); }',
  );
  // Happy DOM drops variable-font descriptors; expose the browser's CSSOM value.
  const style = (sheet.sheet!.cssRules[0] as CSSFontFaceRule).style;
  const read = style.getPropertyValue.bind(style);
  vi.spyOn(style, "getPropertyValue").mockImplementation((name) =>
    name === "font-weight" ? "100 900" : read(name),
  );
  expect(supportsFontFace("Fixture Display", "700", "italic")).toBe(true);
  expect(supportsFontFace("Fixture Display", "950", "italic")).toBe(false);
  expect(getFontStyles("Fixture Display")).toContainEqual({
    weight: "700",
    style: "italic",
  });
  expect(
    getFontStyles("Fixture Display").filter(
      (face) => face.weight === "400" && face.style === "italic",
    ),
  ).toHaveLength(1);
  expect(FontFamilySchema.parse("Fixture Display")).toBe("Fixture Display");
  expect(FontFamilySchema.parse(FontFamily.Inter)).toBe(FontFamily.Inter);
  expect(getFontFamilyName(FontFamily.OrelegaOne)).toBe("Orelega One");
  expect(wrapFontFamily(FontFamily.Inter)).toBe('"Inter"');
});
