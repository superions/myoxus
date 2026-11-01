// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { describe, expect, test } from "vitest";

import { IconType } from "./icon-data";
import { IconRenderer } from "./icon-renderer";

describe("facade IconRenderer", () => {
  test("renders emoji metadata directly", () => {
    expect(IconRenderer({ data: { type: IconType.Emoji, unicode: "✓" } })).toBe(
      "✓",
    );
  });

  test("falls back for unsupported blob metadata", () => {
    const fallback = <span>Fallback</span>;

    expect(
      IconRenderer({
        data: { type: IconType.Blob, blob: new Blob(["icon"]) },
        fallback,
      }),
    ).toBe(fallback);
  });
});
