import { describe, expect, test } from "vitest";

import { buildColorProfileOptions } from "./color-profile-options";

describe("pdf export color profile options", () => {
  test("derives canonical render values from seeded ICC profile rows", () => {
    const options = buildColorProfileOptions([
      { name: "sRGB v4 (system)", profileType: "sRGB" },
      { name: "Artifex CMYK SWOP (system)", profileType: "CMYK" },
      { name: "Customer FOGRA39 Output", profileType: "CMYK" },
    ]);

    expect(options).toEqual([
      { value: "sRGB", label: "sRGB v4 (system)" },
      { value: "CMYK_FOGRA39", label: "Customer FOGRA39 Output" },
      { value: "CMYK_SWOP", label: "Artifex CMYK SWOP (system)" },
    ]);
  });

  test("keeps a persisted selected value during rollout gaps", () => {
    expect(
      buildColorProfileOptions(
        [{ name: "sRGB v4 (system)", profileType: "sRGB" }],
        "CMYK_SWOP",
      ),
    ).toEqual([
      { value: "sRGB", label: "sRGB v4 (system)" },
      { value: "CMYK_SWOP", label: "CMYK SWOP" },
    ]);
  });

  test("does not mislabel generic CMYK profiles as FOGRA39", () => {
    expect(
      buildColorProfileOptions([
        { name: "sRGB v4 (system)", profileType: "sRGB" },
        { name: "Artifex PostScript CMYK (system)", profileType: "CMYK" },
      ]),
    ).toEqual([{ value: "sRGB", label: "sRGB v4 (system)" }]);
  });
});
