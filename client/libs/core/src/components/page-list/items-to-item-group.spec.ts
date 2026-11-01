// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import { itemsToItemGroups } from "./items-to-item-group";
import type { TagMeta } from "./types";

const tag = (id: string): TagMeta => ({
  id,
  color: "tag.teal",
  name: `Tag ${id}`,
});

describe("itemsToItemGroups", () => {
  test("treats an empty group definition list as an ungrouped list", () => {
    const items = [tag("a"), tag("b")];

    expect(itemsToItemGroups(items, [])).toEqual([
      {
        id: "all",
        items,
        allItems: items,
      },
    ]);
  });

  test("keeps unmatched items out only when concrete group definitions exist", () => {
    const items = [tag("a")];

    expect(
      itemsToItemGroups(items, [
        {
          id: "none",
          label: "None",
          match: () => false,
        },
      ]),
    ).toEqual([]);
  });
});
