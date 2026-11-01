// SPDX-License-Identifier: AGPL-3.0-or-later

import { Framework, LiveData, Service, Store } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { Tag } from "./tag";
import { TagList } from "./tag-list";

class TestTagStore extends Store {
  readonly confirmed$ = new LiveData(["tag-b", "tag-a"]);
  async getPageTags() {
    return this.confirmed$.value;
  }
  watchPageTags() {
    return this.confirmed$;
  }

  readonly setPageTags = vi.fn(async (_pageId: string, tagIds: string[]) => {
    this.confirmed$.next(tagIds);
    return tagIds;
  });
  readonly tags$ = new LiveData([
    { id: "tag-a", value: "Alpha", color: "tag.blue" as const },
    { id: "tag-b", value: "Beta", color: "tag.green" as const },
  ]);
  readonly catalogState$ = this.tags$.map((tags) => ({
    status: "ready" as const,
    tags,
    error: null,
  }));

  watchTagIds() {
    return this.tags$.map((tags) => tags.map((tag) => tag.id));
  }

  watchTagInfo(id: string) {
    return this.tags$.map((tags) => tags.find((tag) => tag.id === id));
  }

  watchTagPageIds() {
    return new LiveData<string[]>([]).asObservable();
  }
}

class TestDocsService extends Service {
  constructor(private readonly store: TestTagStore) {
    super();
  }
  readonly meta$ = new LiveData({ tags: ["stale-yjs"] });
  readonly list = {
    doc$: () =>
      new LiveData({ meta$: this.meta$, tagIds$: this.store.confirmed$ }),
  };
}

function createTagList() {
  const framework = new Framework();
  framework
    .store(TestTagStore)
    .service(TestDocsService, [TestTagStore])
    .entity(TagList as any, [TestTagStore, TestDocsService])
    .entity(Tag as any, [TestTagStore, TestDocsService]);

  const provider = framework.provider();
  return {
    docs: provider.get(TestDocsService),
    list: provider.createEntity(TagList),
    store: provider.get(TestTagStore),
  };
}

describe("TagList", () => {
  test("preserves the server assignment order when catalog order differs", () => {
    const { list, docs, store } = createTagList();

    expect(list.tagIdsByPageId$("doc").value).toEqual(["tag-b", "tag-a"]);
    expect(list.tagsByPageId$("doc").value.map((tag) => tag.id)).toEqual([
      "tag-b",
      "tag-a",
    ]);
    docs.meta$.next({ tags: [] });
    expect(list.tagIdsByPageId$("doc").value).toEqual(["tag-b", "tag-a"]);
    store.confirmed$.next(["tag-a"]);
    expect(list.tagsByPageId$("doc").value.map((tag) => tag.id)).toEqual([
      "tag-a",
    ]);
  });

  test("clears the complete server-backed document assignment", async () => {
    const { list, store } = createTagList();

    await expect(list.clearPageTags("doc")).resolves.toEqual([]);
    expect(store.setPageTags).toHaveBeenCalledWith("doc", []);
  });

  test("moves one group tag while preserving every unrelated assignment", async () => {
    const { list, store } = createTagList();

    await expect(list.movePageTag("doc", "tag-b", "tag-c")).resolves.toEqual([
      "tag-c",
      "tag-a",
    ]);
    expect(store.setPageTags).toHaveBeenCalledWith("doc", ["tag-c", "tag-a"]);

    store.setPageTags.mockClear();
    store.confirmed$.next([]);
    await expect(list.movePageTag("doc", null, "tag-c")).resolves.toEqual([
      "tag-c",
    ]);
    expect(store.setPageTags).toHaveBeenCalledWith("doc", ["tag-c"]);
  });
});
