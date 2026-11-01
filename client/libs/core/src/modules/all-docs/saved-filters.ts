import type { Memento } from "@myoxus/infra";
import { LiveData, Service } from "@myoxus/infra";
import { map } from "rxjs";

import type { FilterParams } from "../collection-rules/types";
import type { WorkspaceLocalState } from "../workspace/providers/storage";

const ALL_DOCS_SAVED_FILTERS_KEY = "allDocsSavedFilters";

export type AllDocsSavedFilter = {
  id: string;
  name: string;
  filters: FilterParams[];
  createdAt: number;
  updatedAt: number;
};

export type AllDocsSavedFilterInput = {
  name: string;
  filters: FilterParams[];
};

export class AllDocsSavedFiltersService extends Service {
  constructor(private readonly workspaceLocalState: WorkspaceLocalState) {
    super();
  }

  savedFilters$ = LiveData.from(
    this.workspaceLocalState
      .watch<AllDocsSavedFilter[]>(ALL_DOCS_SAVED_FILTERS_KEY)
      .pipe(map(normalizeSavedFilters)),
    readSavedFilters(this.workspaceLocalState),
  );

  getSavedFilter(id: string) {
    return this.savedFilters$.value.find((filter) => filter.id === id) ?? null;
  }

  createSavedFilter(input: AllDocsSavedFilterInput) {
    const now = Date.now();
    const record: AllDocsSavedFilter = {
      id: createSavedFilterId(),
      name: normalizeName(input.name),
      filters: input.filters,
      createdAt: now,
      updatedAt: now,
    };
    writeSavedFilters(this.workspaceLocalState, [
      ...this.savedFilters$.value,
      record,
    ]);
    return record;
  }

  updateSavedFilter(id: string, input: Partial<AllDocsSavedFilterInput>) {
    const nextFilters = this.savedFilters$.value.map((filter) =>
      filter.id === id
        ? {
            ...filter,
            ...("name" in input ? { name: normalizeName(input.name) } : {}),
            ...("filters" in input ? { filters: input.filters ?? [] } : {}),
            updatedAt: Date.now(),
          }
        : filter,
    );
    writeSavedFilters(this.workspaceLocalState, nextFilters);
  }

  removeSavedFilter(id: string) {
    writeSavedFilters(
      this.workspaceLocalState,
      this.savedFilters$.value.filter((filter) => filter.id !== id),
    );
  }
}

function readSavedFilters(memento: Memento) {
  return normalizeSavedFilters(
    memento.get<AllDocsSavedFilter[]>(ALL_DOCS_SAVED_FILTERS_KEY),
  );
}

function writeSavedFilters(memento: Memento, filters: AllDocsSavedFilter[]) {
  memento.set(ALL_DOCS_SAVED_FILTERS_KEY, normalizeSavedFilters(filters));
}

function normalizeSavedFilters(value: unknown): AllDocsSavedFilter[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is AllDocsSavedFilter => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const candidate = entry as Partial<AllDocsSavedFilter>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.name === "string" &&
        Array.isArray(candidate.filters)
      );
    })
    .map((entry) => ({
      ...entry,
      name: normalizeName(entry.name),
      createdAt:
        typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
      updatedAt:
        typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
    }));
}

function normalizeName(name: string | undefined) {
  return name?.trim() ?? "";
}

function createSavedFilterId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `saved-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
