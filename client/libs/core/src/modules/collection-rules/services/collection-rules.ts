import { Service } from "@myoxus/infra";
import {
  catchError,
  combineLatest,
  distinctUntilChanged,
  map,
  type Observable,
  of,
  shareReplay,
  throttleTime,
} from "rxjs";

import { FilterProvider, GroupByProvider, OrderByProvider } from "../provider";
import type { FilterParams, GroupByParams, OrderByParams } from "../types";

export class CollectionRulesService extends Service {
  constructor() {
    super();
  }

  watch(options: {
    /**
     * Primary filters
     *
     * If filters.length === 0, no items will be matched
     */
    filters?: FilterParams[];
    groupBy?: GroupByParams;
    orderBy?: OrderByParams;
    /**
     * Additional allowed items that bypass primary filters but are still subject to extraFilters
     */
    extraAllowList?: string[];
    /**
     * Additional filters that will be applied after the primary filters and extraAllowList
     *
     * Useful for applying system-level filters such as trash, empty journal, etc.
     *
     * Note: If the primary filters match no items, these extraFilters will not be applied.
     */
    extraFilters?: FilterParams[];
  }): Observable<{
    groups: {
      key: string;
      items: string[];
    }[];
    filterErrors: any[];
  }> {
    const {
      filters = [],
      groupBy,
      orderBy,
      extraAllowList,
      extraFilters = [],
    } = options;

    // STEP 1: FILTER
    const filterProviders = this.framework.getAll(FilterProvider);
    const primaryFiltered$: Observable<{
      filtered: Set<string>;
      filterErrors: any[]; // errors from the filter providers
    }> =
      filters.length === 0
        ? of({
            filtered: new Set<string>([]),
            filterErrors: [],
          })
        : combineLatest(
            filters.map((filter) => {
              const provider = filterProviders.get(filter.type);
              if (!provider) {
                return of({
                  error: new Error(`Unsupported filter type: ${filter.type}`),
                });
              }
              return provider.filter$(filter).pipe(
                distinctUntilChanged((prev, curr) => {
                  return prev.isSubsetOf(curr) && curr.isSubsetOf(prev);
                }),
                catchError((error) => {
                  console.log(error);
                  return of({ error });
                }),
              );
            }),
          ).pipe(
            map((results) => {
              const aggregated = results.reduce((acc, result) => {
                if ("error" in acc) {
                  return acc;
                }
                if ("error" in result) {
                  return acc;
                }
                return acc.intersection(result);
              });

              const filtered =
                "error" in aggregated ? new Set<string>() : aggregated;

              return {
                filtered: filtered,
                filterErrors: results.map((i) =>
                  "error" in i ? i.error : null,
                ),
              };
            }),
          );

    const extraFiltered$ =
      extraFilters.length === 0
        ? of(null)
        : combineLatest(
            extraFilters.map((filter) => {
              const provider = filterProviders.get(filter.type);
              if (!provider) {
                throw new Error(`Unsupported filter type: ${filter.type}`);
              }
              return provider.filter$(filter).pipe(
                distinctUntilChanged((prev, curr) => {
                  return prev.isSubsetOf(curr) && curr.isSubsetOf(prev);
                }),
              );
            }),
          ).pipe(
            map((results) => {
              return results.reduce((acc, result) => {
                return acc.intersection(result);
              });
            }),
          );

    const finalFiltered$ = combineLatest([
      primaryFiltered$,
      extraFiltered$,
    ]).pipe(
      map(([primary, extra]) => ({
        filtered:
          extra === null
            ? primary.filtered.union(new Set(extraAllowList ?? []))
            : primary.filtered
                .union(new Set(extraAllowList ?? []))
                .intersection(extra),
        filterErrors: primary.filterErrors,
      })),
    );

    // STEP 2: ORDER BY
    const orderByProvider = orderBy
      ? this.framework.getOptional(OrderByProvider(orderBy.type))
      : null;
    const ordered$: Observable<{
      ordered: string[];
      filtered: Set<string>;
      filterErrors: any[];
    }> = finalFiltered$.pipe((last$) => {
      if (orderBy && orderByProvider) {
        // Providers and the final merge subscribe separately; replay the current
        // value so synchronous providers cannot make either subscriber miss it.
        const shared$ = last$.pipe(
          shareReplay({ bufferSize: 1, refCount: true }),
        );
        const items$ = shared$.pipe(
          map((i) => i.filtered),
          // avoid re-ordering the same items
          distinctUntilChanged((prev, curr) => {
            return prev.isSubsetOf(curr) && curr.isSubsetOf(prev);
          }),
        );
        return combineLatest([
          orderByProvider.orderBy$(items$, orderBy).pipe(
            catchError((error) => {
              // Return an empty array when orderBy fails, typically when the orderBy property has been deleted
              console.error(error);
              return of([]);
            }),
          ),
          shared$,
        ]).pipe(
          map(([ordered, last]) => {
            return {
              ordered: Array.from(ordered),
              ...last,
            };
          }),
        );
      }
      return last$.pipe(
        map((last) => ({
          ordered: Array.from(last.filtered),
          ...last,
        })),
      );
    });

    // STEP 3: GROUP BY
    const groupByProvider = groupBy
      ? this.framework.getOptional(GroupByProvider(groupBy.type))
      : null;
    const grouped$: Observable<{
      grouped: Map<string, Set<string>>;
      ordered: string[];
      filtered: Set<string>;
      filterErrors: any[];
    }> = ordered$.pipe((last$) => {
      if (groupBy && groupByProvider) {
        const shared$ = last$.pipe(
          shareReplay({ bufferSize: 1, refCount: true }),
        );
        const items$ = shared$.pipe(
          map((i) => i.filtered),
          // avoid re-grouping the same items
          distinctUntilChanged((prev, curr) => {
            return prev.isSubsetOf(curr) && curr.isSubsetOf(prev);
          }),
        );
        return combineLatest([
          groupByProvider.groupBy$(items$, groupBy).pipe(
            catchError((error) => {
              // Return an empty array when groupBy fails, typically when the groupBy property has been deleted
              console.error(error);
              return of(new Map<string, Set<string>>());
            }),
          ),
          shared$,
        ]).pipe(
          map(([grouped, last]) => {
            return {
              grouped: grouped,
              ...last,
            };
          }),
        );
      }
      return last$.pipe(
        map((last) => ({
          grouped: new Map<string, Set<string>>([["", last.filtered]]),
          ...last,
        })),
      );
    });

    // STEP 4: Merge the results
    const final$: Observable<{
      groups: {
        key: string;
        items: string[];
      }[];
      filterErrors: any[];
    }> = grouped$.pipe(
      throttleTime(300, undefined, { leading: true, trailing: true }), // throttle the results to avoid too many re-renders
      map(({ grouped, ordered, filtered, filterErrors }) => {
        const result: { key: string; items: string[] }[] = [];
        const resultByKey = new Map<string, { key: string; items: string[] }>();
        const groupsByItem = new Map<string, string[]>();

        for (const [group, items] of grouped) {
          for (const item of items) {
            const groups = groupsByItem.get(item);
            if (groups) {
              groups.push(group);
            } else {
              groupsByItem.set(item, [group]);
            }
          }
        }

        function addToResult(key: string, item: string) {
          const existing = resultByKey.get(key);
          if (existing) {
            existing.items.push(item);
          } else {
            const group = { key, items: [item] };
            resultByKey.set(key, group);
            result.push(group);
          }
        }

        // this step ensures that all filtered items are present in ordered
        const finalOrdered = new Set(ordered.concat(Array.from(filtered)));

        for (const item of finalOrdered) {
          const included = filtered.has(item);
          if (!included) {
            continue;
          }

          const groups = groupsByItem.get(item);

          if (!groups || groups.length === 0) {
            // ungrouped items
            addToResult("", item);
          } else {
            for (const group of groups) {
              addToResult(group, item);
            }
          }
        }

        return { groups: result, filterErrors };
      }),
    );

    return final$;
  }
}
