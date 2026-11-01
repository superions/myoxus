/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createIdentifier,
  Framework,
  LiveData,
  useLiveData,
} from "@myoxus/infra";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { DocsService } from "../../doc";
import type { DocRecord } from "../../doc/entities/record";
import type { TagStore } from "../stores/tag";
import { Tag } from "./tag";
import { TagList } from "./tag-list";

afterEach(cleanup);

test("row subscriptions survive rerenders while assignments and catalog removals stay reactive", () => {
  const ids$ = new LiveData(["first", "second"]);
  const assignment$ = new LiveData(["second", "first"]);
  const doc$ = new LiveData({ tagIds$: assignment$ } as DocRecord | undefined);
  const doc = vi.fn(() => doc$);
  const StoreForTest = createIdentifier<TagStore>("TagStoreForListTest");
  const DocsForTest = createIdentifier<DocsService>("DocsForTagListTest");
  const framework = new Framework();
  framework.addValue(StoreForTest, {
    catalogState$: new LiveData({ status: "ready", tags: [], error: null }),
    watchTagIds: () => ids$.asObservable(),
    watchTagInfo: (id: string) =>
      new LiveData({ id, value: id }).asObservable(),
    watchTagPageIds: () => new LiveData([]).asObservable(),
  } as unknown as TagStore);
  framework.addValue(DocsForTest, {
    list: { doc$: doc },
  } as unknown as DocsService);
  framework.entity(Tag, [StoreForTest, DocsForTest]);
  framework.entity(TagList, [StoreForTest, DocsForTest]);
  const provider = framework.provider();
  const list = provider.createEntity(TagList);
  const Row = () => {
    const tags = useLiveData(list.tagsByPageId$("page"));
    return <output>{tags.map((tag) => tag.id).join(",")}</output>;
  };
  const view = render(<Row />);
  expect(screen.getByRole("status").textContent).toBe("second,first");
  for (let i = 0; i < 5; i++) view.rerender(<Row />);
  expect(doc).toHaveBeenCalledOnce();
  act(() => assignment$.next(["first", "second"]));
  expect(screen.getByRole("status").textContent).toBe("first,second");
  act(() => ids$.next(["second"]));
  expect(screen.getByRole("status").textContent).toBe("second");
  act(() => doc$.next(undefined));
  expect(screen.getByRole("status").textContent).toBe("");
  view.unmount();
  provider.dispose();
});
