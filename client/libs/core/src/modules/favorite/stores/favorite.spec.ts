// SPDX-License-Identifier: AGPL-3.0-or-later

import { createIdentifier, Framework, LiveData } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import type { WorkspaceDBService } from "../../db";
import { FavoriteStore } from "./favorite";

const WorkspaceDBServiceForTest = createIdentifier<WorkspaceDBService>(
  "WorkspaceDBServiceForFavoriteTest",
);

function createFavoriteTable() {
  const rows = new Map<string, { key: string; index: string }>();
  const rows$ = new LiveData<Array<{ key: string; index: string }>>([]);
  const emit = () => rows$.next([...rows.values()]);
  return {
    create: vi.fn((record: { key: string; index: string }) => {
      rows.set(record.key, record);
      emit();
      return record;
    }),
    delete: vi.fn((key: string) => {
      rows.delete(key);
      emit();
    }),
    find$: vi.fn(() => rows$),
    get$: vi.fn((key: string) => rows$.map(() => rows.get(key) ?? null)),
    isLoading$: new LiveData(false),
    update: vi.fn((key: string, update: { index: string }) => {
      const current = rows.get(key);
      if (current) rows.set(key, { ...current, ...update });
      emit();
    }),
  };
}

function resolveFavoriteStore(table: ReturnType<typeof createFavoriteTable>) {
  const dbService = {
    userdataDB$: new LiveData({ favorite: table }),
  } as unknown as WorkspaceDBService;
  const framework = new Framework();
  framework.impl(WorkspaceDBServiceForTest, dbService);
  framework.store(FavoriteStore, [WorkspaceDBServiceForTest]);
  return framework.provider().get(FavoriteStore);
}

describe("FavoriteStore typed Page persistence", () => {
  test("reloads overlapping document and Database IDs without dropping either kind", () => {
    const table = createFavoriteTable();
    const store = resolveFavoriteStore(table);
    store.addFavorite("doc", "shared:id", "a0");
    store.addFavorite("database", "shared:id", "a1");

    const reloaded = resolveFavoriteStore(table);
    expect(
      reloaded
        .watchFavorites()
        .value.map(({ type, id, index }) => `${type}:${id}:${index}`),
    ).toEqual(["doc:shared:id:a0", "database:shared:id:a1"]);

    reloaded.reorderFavorite("database", "shared:id", "a2");
    reloaded.removeFavorite("doc", "shared:id");
    expect(reloaded.watchFavorites().value).toEqual([
      { type: "database", id: "shared:id", index: "a2" },
    ]);
  });
});
