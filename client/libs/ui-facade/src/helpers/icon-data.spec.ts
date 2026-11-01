// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { type IconData, IconType } from "./icon-data";

describe("facade icon data contract", () => {
  test("keeps icon discriminants stable for stored explorer metadata", () => {
    const icon: IconData = {
      type: IconType.MyoxusIcon,
      name: "Page",
      color: "var(--myoxus-icon-color)",
    };

    expect(IconType).toEqual({
      Emoji: "emoji",
      MyoxusIcon: "myoxus-icon",
      Blob: "blob",
    });
    expect(icon.type).toBe("myoxus-icon");
  });
});
