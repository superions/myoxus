// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { DocsService } from "../../doc/services/docs";
import { DocsSearchService } from "../../docs-search/services/docs-search";

import { WorkspaceService } from "../../workspace/services/workspace";

import { Framework } from "@myoxus/infra";
import { BehaviorSubject, firstValueFrom, map, throwError } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createTitleMatcher,
  TitleFilterProvider,
} from "../impls/filters/title";

import { FilterProvider, GroupByProvider, OrderByProvider } from "../provider";
import { CollectionRulesService } from "./collection-rules";

function createService(options: {
  filtered?: Set<string>;
  grouped?: Map<string, Set<string>>;
  ordered?: string[];
  filterError?: Error;
}) {
  const framework = new Framework();
  framework
    .service(CollectionRulesService)
    .impl(FilterProvider("fixture"), {
      filter$: () =>
        options.filterError
          ? throwError(() => options.filterError)
          : new BehaviorSubject(options.filtered ?? new Set<string>()),
    })
    .impl(GroupByProvider("fixture"), {
      groupBy$: (items$) =>
        items$.pipe(map(() => options.grouped ?? new Map())),
    })
    .impl(OrderByProvider("fixture"), {
      orderBy$: () => new BehaviorSubject(options.ordered ?? []),
    });
  return framework.provider().get(CollectionRulesService);
}

describe("CollectionRulesService", () => {
  test("preserves exact group and item order through the real watch pipeline", async () => {
    const service = createService({
      filtered: new Set([
        "multi",
        "duplicate",
        "ungrouped",
        "explicit-empty",
        "unordered",
      ]),
      ordered: ["duplicate", "multi", "filtered-out", "duplicate"],
      grouped: new Map([
        ["group-b", new Set(["multi", "duplicate", "filtered-out"])],
        ["", new Set(["explicit-empty"])],
        ["group-a", new Set(["multi", "unordered"])],
      ]),
    });

    await expect(
      firstValueFrom(
        service.watch({
          filters: [{ type: "fixture", key: "", method: "" }],
          orderBy: { type: "fixture", key: "" },
          groupBy: { type: "fixture", key: "" },
        }),
      ),
    ).resolves.toEqual({
      groups: [
        { key: "group-b", items: ["duplicate", "multi"] },
        { key: "group-a", items: ["multi", "unordered"] },
        { key: "", items: ["ungrouped", "explicit-empty"] },
      ],
      filterErrors: [null],
    });
  });

  test("forwards primary filter errors without producing items", async () => {
    const error = new Error("fixture filter failed");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const service = createService({ filterError: error });

    await expect(
      firstValueFrom(
        service.watch({
          filters: [{ type: "fixture", key: "", method: "" }],
        }),
      ),
    ).resolves.toEqual({ groups: [], filterErrors: [error] });
    expect(consoleSpy).toHaveBeenCalledWith(error);
    consoleSpy.mockRestore();
  });

  test("traverses each membership once instead of probing every group per item", async () => {
    const itemCount = 120;
    const groupCount = 40;
    let membershipIterations = 0;
    let membershipProbes = 0;

    class ObservedSet extends Set<string> {
      override has(value: string) {
        membershipProbes += 1;
        return super.has(value);
      }

      override *[Symbol.iterator](): Generator<string, undefined, unknown> {
        for (const value of super[Symbol.iterator]()) {
          membershipIterations += 1;
          yield value;
        }
        return undefined;
      }
    }

    const items = Array.from(
      { length: itemCount },
      (_, index) => `item-${index}`,
    );
    const grouped = new Map<string, Set<string>>();
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
      grouped.set(
        `group-${groupIndex}`,
        new ObservedSet(
          items.filter(
            (_, itemIndex) =>
              itemIndex % groupCount === groupIndex ||
              (itemIndex + 1) % groupCount === groupIndex,
          ),
        ),
      );
    }
    const service = createService({
      filtered: new Set(items),
      ordered: items,
      grouped,
    });

    const result = await firstValueFrom(
      service.watch({
        filters: [{ type: "fixture", key: "", method: "" }],
        orderBy: { type: "fixture", key: "" },
        groupBy: { type: "fixture", key: "" },
      }),
    );

    expect(result.groups).toHaveLength(groupCount);
    expect(
      result.groups.reduce((total, group) => total + group.items.length, 0),
    ).toBe(itemCount * 2);
    expect(membershipIterations).toBe(itemCount * 2);
    expect(membershipProbes).toBe(0);
  });
});

describe("catalogue title matching", () => {
  test.each([["ello", "Hello world", false]])(
    "query %j matches title %j: %s",
    (query, title, expected) => {
      expect(createTitleMatcher(query)(title)).toBe(expected);
    },
  );
});

describe("Browser Web Collection title ownership", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function fixture(flavour = "myoxus-cloud") {
    vi.stubGlobal("BUILD_CONFIG", {
      ...BUILD_CONFIG,
      isWeb: true,
      isElectron: false,
      isIOS: false,
      isAndroid: false,
    });
    const titles = new BehaviorSubject([
      { id: "a", title: "Alpha" },
      { id: "b", title: "alphabet" },
      { id: "c", title: "Other" },
      { id: "d", title: "Alpha four" },
      { id: "trash", title: "Alpha trashed" },
    ]);
    const active = new BehaviorSubject(["a", "b", "c", "d"]);
    const allDocTitle$ = vi.fn(() => titles);
    const allNonTrashDocIds$ = vi.fn(() => active);
    const searchTitle$ = vi.fn(() => new BehaviorSubject(["indexed-only"]));
    const docs = { allDocTitle$, allNonTrashDocIds$ } as unknown as DocsService;
    const search = { searchTitle$ } as unknown as DocsSearchService;
    const workspace = { workspace: { flavour } } as unknown as WorkspaceService;
    const framework = new Framework();
    framework
      .service(DocsSearchService, search)
      .service(DocsService, docs)
      .service(WorkspaceService, workspace)
      .service(TitleFilterProvider, [
        DocsSearchService,
        DocsService,
        WorkspaceService,
      ]);
    return {
      titles,
      active,
      docs,
      search,
      workspace,
      provider: framework.provider().get(TitleFilterProvider),
      allDocTitle$,
      allNonTrashDocIds$,
      searchTitle$,
    };
  }

  const filter = {
    type: "system:title",
    key: "",
    method: "match",
    value: "alp",
  };

  test("uses catalogue previews/acknowledgements and active membership without indexing", () => {
    const f = fixture();
    let result = new Set<string>();
    const subscription = f.provider
      .filter$(filter)
      .subscribe((value) => (result = value));
    try {
      expect(result).toEqual(new Set(["a", "b", "d"]));
      f.titles.next([
        { id: "a", title: "Other preview" },
        { id: "c", title: "Alpha preview" },
        { id: "trash", title: "Alpha" },
      ]);
      expect(result).toEqual(new Set(["c"]));
      f.titles.next([
        { id: "c", title: "Alpha acknowledged" },
        { id: "new", title: "Alpha created" },
      ]);
      f.active.next(["c", "new"]);
      expect(result).toEqual(new Set(["c", "new"]));
      f.active.next(["new"]);
      expect(result).toEqual(new Set(["new"]));
      f.active.next(["c", "new"]);
      expect(result).toEqual(new Set(["c", "new"]));
      f.titles.next([{ id: "c", title: "Alpha acknowledged" }]);
      expect(result).toEqual(new Set(["c"]));
      expect(f.searchTitle$).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
    }
  });

  test.each([["myoxus-cloud", { isWeb: false }]])(
    "preserves index search for %s and %j",
    async (flavour, platform) => {
      const f = fixture(flavour);
      vi.stubGlobal("BUILD_CONFIG", { ...BUILD_CONFIG, ...platform });
      expect(await firstValueFrom(f.provider.filter$(filter))).toEqual(
        new Set(["indexed-only"]),
      );
      expect(f.searchTitle$).toHaveBeenCalledExactlyOnceWith("alp");
      expect(f.allDocTitle$).not.toHaveBeenCalled();
      expect(f.allNonTrashDocIds$).not.toHaveBeenCalled();
    },
  );

  test("real title provider preserves the consuming extra-filter/order/group pipeline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const framework = new Framework();
    framework
      .service(CollectionRulesService)
      .impl(FilterProvider("system:title"), f.provider)
      .impl(FilterProvider("extra"), {
        filter$: () => new BehaviorSubject(new Set(["b", "d", "trash"])),
      })
      .impl(OrderByProvider("fixture"), {
        orderBy$: () => new BehaviorSubject(["d", "b", "trash"]),
      })
      .impl(GroupByProvider("fixture"), {
        groupBy$: () =>
          new BehaviorSubject(
            new Map([["named", new Set(["b", "d", "trash"])]]),
          ),
      });
    const service = framework.provider().get(CollectionRulesService);
    let result: unknown;
    const subscription = service
      .watch({
        filters: [filter],
        extraFilters: [{ type: "extra", key: "", method: "" }],
        orderBy: { type: "fixture", key: "" },
        groupBy: { type: "fixture", key: "" },
      })
      .subscribe((value) => (result = value));
    try {
      expect(result).toEqual({
        groups: [{ key: "named", items: ["d", "b"] }],
        filterErrors: [null],
      });
      f.active.next(["b", "trash"]);
      await vi.advanceTimersByTimeAsync(301);
      expect(result).toEqual({
        groups: [{ key: "named", items: ["b", "trash"] }],
        filterErrors: [null],
      });
      expect(f.allDocTitle$).toHaveBeenCalledTimes(1);
      expect(f.allNonTrashDocIds$).toHaveBeenCalledTimes(1);
      expect(f.searchTitle$).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
    }
    expect(f.titles.observed).toBe(false);
    expect(f.active.observed).toBe(false);
  });
});
