import { Framework, MemoryMemento } from "@myoxus/infra";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceLocalState } from "../workspace/providers/storage";
import { AllDocsSavedFiltersService } from "./saved-filters";

describe("AllDocsSavedFiltersService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("persists saved filters in workspace-local user state", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const { service, state } = createServiceFixture();

    const record = service.createSavedFilter({
      name: "  My filter  ",
      filters: [
        {
          type: "system",
          key: "favorite",
          method: "is",
          value: "true",
        },
      ],
    });

    expect(record.name).toBe("My filter");
    expect(state.keys()).toEqual(["allDocsSavedFilters"]);
    expect(state.get("allDocsSavedFilters")).toEqual([
      expect.objectContaining({
        id: record.id,
        name: "My filter",
        createdAt: 1234,
        updatedAt: 1234,
      }),
    ]);
  });

  test("updates and removes saved filters without collection records", () => {
    const { service } = createServiceFixture();
    const record = service.createSavedFilter({
      name: "Status",
      filters: [],
    });

    service.updateSavedFilter(record.id, {
      name: "Status open",
      filters: [
        {
          type: "system",
          key: "trash",
          method: "is",
          value: "false",
        },
      ],
    });

    expect(service.getSavedFilter(record.id)).toEqual(
      expect.objectContaining({
        id: record.id,
        name: "Status open",
        filters: [
          {
            type: "system",
            key: "trash",
            method: "is",
            value: "false",
          },
        ],
      }),
    );

    service.removeSavedFilter(record.id);

    expect(service.savedFilters$.value).toEqual([]);
  });
});

function createServiceFixture() {
  const framework = new Framework();
  const state = new MemoryMemento();
  framework
    .impl(WorkspaceLocalState, state)
    .service(AllDocsSavedFiltersService, [WorkspaceLocalState]);

  return {
    state,
    service: framework.provider().get(AllDocsSavedFiltersService),
  };
}
