// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workspace } from "@virgultum/editor/store";
import { describe, expect, test } from "vitest";

import { toListPropsAtomSnapshot } from "./list";
import type { ListItem, ListProps, TagMeta } from "./types";

const tag = (id: string): TagMeta => ({
  id,
  color: "tag.teal",
  name: `Tag ${id}`,
});

const docCollection = {} as Workspace;

describe("toListPropsAtomSnapshot", () => {
  test("breaks mutable service array identity before props enter scoped atoms", () => {
    const items: ListItem[] = [tag("a")];
    const selectedIds = ["a"];
    const props: ListProps<ListItem> = {
      docCollection,
      items,
      selectedIds,
    };

    const snapshot = toListPropsAtomSnapshot(props);

    expect(snapshot.items).toEqual(items);
    expect(snapshot.items).not.toBe(items);
    expect(snapshot.selectedIds).toEqual(selectedIds);
    expect(snapshot.selectedIds).not.toBe(selectedIds);

    items.push(tag("b"));
    selectedIds.push("b");

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.selectedIds).toEqual(["a"]);
  });

  test("preserves virtualized heading props across immutable atom snapshots", () => {
    const heading = "Tags";
    const props: ListProps<ListItem> & { heading: string } = {
      docCollection,
      heading,
      items: [tag("a")],
    };

    expect(toListPropsAtomSnapshot(props).heading).toBe(heading);
  });
});
