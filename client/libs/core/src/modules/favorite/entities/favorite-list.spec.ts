import { createIdentifier, Framework, LiveData, Store } from "@myoxus/infra";
import { describe, expect, test } from "vitest";

import type { FavoriteSupportTypeUnion } from "../constant";
import type { FavoriteRecord } from "../stores/favorite";
import { FavoriteList } from "./favorite-list";

class TestFavoriteStore extends Store {
  readonly records$ = new LiveData<FavoriteRecord[]>([]);
  readonly loading$ = new LiveData(false);

  watchFavorites() {
    return this.records$;
  }

  watchIsLoading() {
    return this.loading$;
  }

  watchFavorite(type: FavoriteSupportTypeUnion, id: string) {
    return this.records$.map((records) =>
      records.find((record) => record.type === type && record.id === id),
    );
  }

  addFavorite(
    type: FavoriteSupportTypeUnion,
    id: string,
    index: string,
  ): FavoriteRecord {
    const record = { type, id, index };
    this.records$.next([
      ...this.records$.value.filter(
        (item) => item.type !== type || item.id !== id,
      ),
      record,
    ]);
    return record;
  }

  reorderFavorite(type: FavoriteSupportTypeUnion, id: string, index: string) {
    this.records$.next(
      this.records$.value.map((record) =>
        record.type === type && record.id === id
          ? { ...record, index }
          : record,
      ),
    );
  }

  removeFavorite(type: FavoriteSupportTypeUnion, id: string) {
    this.records$.next(
      this.records$.value.filter(
        (record) => record.type !== type || record.id !== id,
      ),
    );
  }
}

const FavoriteStoreForTest = createIdentifier<TestFavoriteStore>(
  "FavoriteStoreForTest",
);

function createFavoriteListFixture() {
  const framework = new Framework();
  framework
    .store(TestFavoriteStore)
    .impl(FavoriteStoreForTest, TestFavoriteStore)
    .entity(FavoriteList as any, [FavoriteStoreForTest]);

  const provider = framework.provider();
  return {
    list: provider.createEntity(FavoriteList),
    store: provider.get(TestFavoriteStore),
  };
}

describe("FavoriteList", () => {
  test("adds dragged records and reorders mixed favorite types with fractional indexes", () => {
    const { list } = createFavoriteListFixture();

    list.add("doc", "doc-a", list.indexAt("after"));
    list.add("database", "doc-a", list.indexAt("after"));
    list.add("collection", "collection-a", list.indexAt("after"));
    list.add("tag", "tag-a", list.indexAt("before"));

    expect(
      list.sortedList$.value.map(({ type, id }) => `${type}:${id}`),
    ).toEqual([
      "tag:tag-a",
      "doc:doc-a",
      "database:doc-a",
      "collection:collection-a",
    ]);

    list.reorder(
      "collection",
      "collection-a",
      list.indexAt("before", { type: "doc", id: "doc-a" }),
    );

    expect(
      list.sortedList$.value.map(({ type, id }) => `${type}:${id}`),
    ).toEqual([
      "tag:tag-a",
      "collection:collection-a",
      "doc:doc-a",
      "database:doc-a",
    ]);
  });

  test("rejects reorder indexes for missing favorite targets", () => {
    const { list } = createFavoriteListFixture();

    list.add("doc", "doc-a", list.indexAt("after"));

    expect(() =>
      list.indexAt("before", { type: "collection", id: "missing" }),
    ).toThrow("Target favorite record not found");
  });
});
