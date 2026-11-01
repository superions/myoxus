import { describe, expect, test } from "vitest";

import {
  allDocsFavoriteFilters,
  allDocsNavigationMatches,
  allDocsNavigationTo,
  parseAllDocsDisplayView,
  parseAllDocsNavigationSearch,
} from "./navigation";

describe("All Docs navigation filters", () => {
  test("parses fixed, saved-filter and collection query strings", () => {
    expect(parseAllDocsNavigationSearch("")).toEqual({ kind: "all" });
    expect(parseAllDocsNavigationSearch("?filter=favorites")).toEqual({
      kind: "favorites",
    });
    expect(parseAllDocsNavigationSearch("?filter=tags")).toEqual({
      kind: "tags",
    });
    expect(parseAllDocsNavigationSearch("?savedFilter=filter123")).toEqual({
      kind: "savedFilter",
      savedFilterId: "filter123",
    });
    expect(parseAllDocsNavigationSearch("?collection=abc123")).toEqual({
      kind: "collection",
      collectionId: "abc123",
    });
  });

  test("keeps the graph addressable without changing the inventory target", () => {
    expect(parseAllDocsDisplayView("?view=graph")).toBe("graph");
    expect(parseAllDocsDisplayView("?filter=favorites")).toBeNull();
    expect(allDocsNavigationTo({ kind: "all" }, { view: "graph" })).toEqual({
      pathname: "/all",
      search: "?view=graph",
      hash: "",
    });
  });

  test("builds Workbench-safe route targets without undefined hash fragments", () => {
    expect(allDocsNavigationTo({ kind: "all" })).toEqual({
      pathname: "/all",
      search: "",
      hash: "",
    });
    expect(allDocsNavigationTo({ kind: "favorites" })).toEqual({
      pathname: "/all",
      search: "?filter=favorites",
      hash: "",
    });
    expect(allDocsNavigationTo({ kind: "tags" })).toEqual({
      pathname: "/all",
      search: "?filter=tags",
      hash: "",
    });
    expect(
      allDocsNavigationTo({ kind: "savedFilter", savedFilterId: "filter123" }),
    ).toEqual({
      pathname: "/all",
      search: "?savedFilter=filter123",
      hash: "",
    });
    expect(
      allDocsNavigationTo({ kind: "collection", collectionId: "abc123" }),
    ).toEqual({
      pathname: "/all",
      search: "?collection=abc123",
      hash: "",
    });
  });

  test("matches collection filters by id instead of only by kind", () => {
    expect(
      allDocsNavigationMatches(
        { kind: "collection", collectionId: "a" },
        { kind: "collection", collectionId: "a" },
      ),
    ).toBe(true);
    expect(
      allDocsNavigationMatches(
        { kind: "collection", collectionId: "a" },
        { kind: "collection", collectionId: "b" },
      ),
    ).toBe(false);
  });

  test("matches saved filters by id instead of only by kind", () => {
    expect(
      allDocsNavigationMatches(
        { kind: "savedFilter", savedFilterId: "a" },
        { kind: "savedFilter", savedFilterId: "a" },
      ),
    ).toBe(true);
    expect(
      allDocsNavigationMatches(
        { kind: "savedFilter", savedFilterId: "a" },
        { kind: "savedFilter", savedFilterId: "b" },
      ),
    ).toBe(false);
  });

  test("keeps favorites scoped to normal all-docs results", () => {
    expect(allDocsFavoriteFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "trash",
          method: "is",
          value: "false",
        }),
        expect.objectContaining({
          key: "template",
          method: "is",
          value: "false",
        }),
        expect.objectContaining({
          key: "favorite",
          method: "is",
          value: "true",
        }),
      ]),
    );
  });
});
