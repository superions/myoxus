import type { FilterParams } from "@myoxus/core/modules/collection-rules/types";
import type { To } from "react-router";

export type AllDocsNavigationTarget =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "tags" }
  | { kind: "savedFilter"; savedFilterId: string }
  | { kind: "collection"; collectionId: string };

export type AllDocsDisplayView = "graph";

const ALL_DOCS_FILTER_PARAM = "filter";
const ALL_DOCS_COLLECTION_PARAM = "collection";
const ALL_DOCS_SAVED_FILTER_PARAM = "savedFilter";
const ALL_DOCS_FAVORITES_FILTER_VALUE = "favorites";
const ALL_DOCS_TAGS_FILTER_VALUE = "tags";
const ALL_DOCS_VIEW_PARAM = "view";

export const allDocsFavoriteFilter: FilterParams = {
  type: "system",
  key: "favorite",
  method: "is",
  value: "true",
};

export const allDocsDefaultFilters: FilterParams[] = [
  {
    type: "system",
    key: "trash",
    method: "is",
    value: "false",
  },
  {
    type: "system",
    key: "template",
    method: "is",
    value: "false",
  },
];

export const allDocsFavoriteFilters: FilterParams[] = [
  ...allDocsDefaultFilters,
  allDocsFavoriteFilter,
];

export function parseAllDocsNavigationSearch(
  search: string,
): AllDocsNavigationTarget {
  const params = new URLSearchParams(search);
  const savedFilterId = params.get(ALL_DOCS_SAVED_FILTER_PARAM);
  if (savedFilterId) {
    return { kind: "savedFilter", savedFilterId };
  }

  const collectionId = params.get(ALL_DOCS_COLLECTION_PARAM);
  if (collectionId) {
    return { kind: "collection", collectionId };
  }

  if (params.get(ALL_DOCS_FILTER_PARAM) === ALL_DOCS_FAVORITES_FILTER_VALUE) {
    return { kind: "favorites" };
  }
  if (params.get(ALL_DOCS_FILTER_PARAM) === ALL_DOCS_TAGS_FILTER_VALUE) {
    return { kind: "tags" };
  }

  return { kind: "all" };
}

export function parseAllDocsDisplayView(
  search: string,
): AllDocsDisplayView | null {
  return new URLSearchParams(search).get(ALL_DOCS_VIEW_PARAM) === "graph"
    ? "graph"
    : null;
}

export function allDocsNavigationTo(
  target: AllDocsNavigationTarget,
  options?: { view?: AllDocsDisplayView },
): To {
  const params = new URLSearchParams();
  if (target.kind === "favorites") {
    params.set(ALL_DOCS_FILTER_PARAM, ALL_DOCS_FAVORITES_FILTER_VALUE);
  } else if (target.kind === "tags") {
    params.set(ALL_DOCS_FILTER_PARAM, ALL_DOCS_TAGS_FILTER_VALUE);
  } else if (target.kind === "savedFilter") {
    params.set(ALL_DOCS_SAVED_FILTER_PARAM, target.savedFilterId);
  } else if (target.kind === "collection") {
    params.set(ALL_DOCS_COLLECTION_PARAM, target.collectionId);
  }
  if (options?.view) {
    params.set(ALL_DOCS_VIEW_PARAM, options.view);
  }

  return {
    pathname: "/all",
    search: params.size ? `?${params.toString()}` : "",
    hash: "",
  };
}

export function allDocsNavigationMatches(
  actual: AllDocsNavigationTarget,
  expected: AllDocsNavigationTarget,
): boolean {
  if (actual.kind !== expected.kind) {
    return false;
  }

  if (actual.kind === "collection" && expected.kind === "collection") {
    return actual.collectionId === expected.collectionId;
  }

  if (actual.kind === "savedFilter" && expected.kind === "savedFilter") {
    return actual.savedFilterId === expected.savedFilterId;
  }

  return true;
}
