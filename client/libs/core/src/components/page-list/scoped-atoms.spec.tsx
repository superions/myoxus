/**
 * @vitest-environment happy-dom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Workspace } from "@virgultum/editor/store";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  listPropsAtom,
  ListProvider,
  rangeIdsAtom,
  useAtomValue,
  useSetAtom,
} from "./scoped-atoms";
import type { ListItem, ListProps, TagMeta } from "./types";

afterEach(cleanup);

const docCollection = {} as Workspace;

function listProps(id: string): ListProps<ListItem> {
  const item: TagMeta = { id, color: "tag.teal", name: id };
  return { docCollection, items: [item] };
}

function Probe({ id }: { id: string }) {
  const props = useAtomValue(listPropsAtom);
  const rangeIds = useAtomValue(rangeIdsAtom);
  const setRangeIds = useSetAtom(rangeIdsAtom);

  return (
    <button data-testid={id} onClick={() => setRangeIds([id])}>
      {props?.items[0]?.id}:{rangeIds.join(",")}
    </button>
  );
}

describe("ListProvider", () => {
  test("keeps list atoms isolated between mounted lists", () => {
    render(
      <>
        <ListProvider initialListProps={listProps("alpha")}>
          <Probe id="alpha" />
        </ListProvider>
        <ListProvider initialListProps={listProps("beta")}>
          <Probe id="beta" />
        </ListProvider>
      </>,
    );

    fireEvent.click(screen.getByTestId("alpha"));

    expect(screen.getByTestId("alpha").textContent).toBe("alpha:alpha");
    expect(screen.getByTestId("beta").textContent).toBe("beta:");
  });
});
