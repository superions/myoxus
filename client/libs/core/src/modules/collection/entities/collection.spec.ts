import {
  createIdentifier,
  Framework,
  LiveData,
  Service,
  Store,
} from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import type { CollectionInfo } from "../stores/collection";
import { Collection } from "./collection";

class TestCollectionStore extends Store {
  readonly collection$ = new LiveData<CollectionInfo | null>({
    id: "collection-1",
    name: "Drag target",
    rules: { filters: [] },
    allowList: ["doc-existing"],
  });

  readonly updateCollectionInfo = vi.fn(
    (id: string, info: Partial<Omit<CollectionInfo, "id">>) => {
      const current = this.collection$.value;
      if (!current || current.id !== id) {
        throw new Error(`Unknown collection ${id}`);
      }
      this.collection$.next({ ...current, ...info });
    },
  );

  watchCollectionInfo(id: string) {
    return this.collection$.map((collection) =>
      collection?.id === id ? collection : null,
    );
  }
}

class TestCollectionRulesService extends Service {
  watch = vi.fn();
}

const CollectionStoreForTest = createIdentifier<TestCollectionStore>(
  "CollectionStoreForTest",
);
const CollectionRulesServiceForTest =
  createIdentifier<TestCollectionRulesService>("CollectionRulesServiceForTest");

function createCollectionFixture() {
  const framework = new Framework();
  framework
    .store(TestCollectionStore)
    .service(TestCollectionRulesService)
    .impl(CollectionStoreForTest, TestCollectionStore)
    .impl(CollectionRulesServiceForTest, TestCollectionRulesService)
    .entity(Collection as any, [
      CollectionStoreForTest,
      CollectionRulesServiceForTest,
    ]);

  const provider = framework.provider();
  return {
    collection: provider.createEntity(Collection, { id: "collection-1" }),
    store: provider.get(CollectionStoreForTest),
  };
}

describe("Collection", () => {
  test("adds dragged documents to the allow list without duplicating existing entries", () => {
    const { collection, store } = createCollectionFixture();

    collection.addDoc("doc-new", "doc-existing");

    expect(store.updateCollectionInfo).toHaveBeenCalledExactlyOnceWith(
      "collection-1",
      {
        allowList: ["doc-existing", "doc-new"],
      },
    );
    expect(collection.allowList$.value).toEqual(["doc-existing", "doc-new"]);
  });

  test("removes documents from the allow list while preserving other manual entries", () => {
    const { collection, store } = createCollectionFixture();

    collection.addDoc("doc-new");
    collection.removeDoc("doc-existing");

    expect(store.updateCollectionInfo).toHaveBeenLastCalledWith(
      "collection-1",
      {
        allowList: ["doc-new"],
      },
    );
    expect(collection.allowList$.value).toEqual(["doc-new"]);
  });
});
