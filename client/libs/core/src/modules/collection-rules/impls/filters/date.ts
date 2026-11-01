import type { DocsService } from "@myoxus/core/modules/doc";
import type { WorkspacePropertyFilter } from "@myoxus/core/modules/workspace-property";
import { Service } from "@myoxus/infra";
import dayjs, { type Dayjs, isDayjs } from "dayjs";
import { map, type Observable } from "rxjs";

import type { FilterProvider } from "../../provider";
import type { FilterParams } from "../../types";

export class DatePropertyFilterProvider
  extends Service
  implements FilterProvider
{
  constructor(private readonly docsService: DocsService) {
    super();
  }

  filter$(params: FilterParams): Observable<Set<string>> {
    return this.docsService
      .propertyValues$("custom:" + params.key)
      .pipe(basicDateFilter(params));
  }
}

export function basicDateFilter(
  params: FilterParams,
): (
  upstream$: Observable<Map<string, string | number | undefined>>,
) => Observable<Set<string>> {
  return (upstream$) => {
    // value can be like "2025-01-01,2025-01-02"
    // or "2025-01-01"
    return upstream$.pipe(
      map((o) => {
        const match = new Set<string>();
        for (const [id, value] of o) {
          if (matchesDateFilterValue(params, value)) match.add(id);
        }
        return match;
      }),
    );
  };
}

/** Shared date predicate for document and Database Page projections. */
export function matchesDateFilterValue(
  params: FilterParams,
  value: string | number | undefined | null,
  now: Dayjs = dayjs(),
): boolean {
  const method = params.method as WorkspacePropertyFilter<"date">;
  if (method === "is-empty" || method === "is-not-empty") {
    return method === "is-empty" ? !value : !!value;
  }
  if (!value) return false;

  const parsed = parseDate(value);
  if (!parsed) return false;
  const filterValues = (params.value
    ?.split(",")
    .map((candidate) => parseDate(candidate))
    .filter(Boolean) ?? []) as [number, number, number][];
  const relativeRanges: Record<string, Dayjs> = {
    "last-3-days": now.subtract(3, "day"),
    "last-7-days": now.subtract(7, "day"),
    "last-15-days": now.subtract(15, "day"),
    "last-30-days": now.subtract(30, "day"),
    "this-week": now.startOf("week"),
    "this-month": now.startOf("month"),
    // @ts-expect-error dayjs quarter support is provided by the configured plugin.
    "this-quarter": now.startOf("quarter"),
    "this-year": now.startOf("year"),
  };

  if (method === "between" && filterValues.length >= 2) {
    return (
      isAfter(parsed, filterValues[0]) && isBefore(parsed, filterValues[1])
    );
  }
  if (method === "after" && filterValues.length >= 1) {
    return isAfter(parsed, filterValues[0]);
  }
  if (method === "before" && filterValues.length >= 1) {
    return isBefore(parsed, filterValues[0]);
  }
  if (method in relativeRanges) return isAfter(parsed, relativeRanges[method]);
  throw new Error(`Unsupported method: ${method}`);
}

function parseDate(value: string | number): [number, number, number] | null {
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [_, year, month, day] = match;
      return [parseInt(year), parseInt(month), parseInt(day)];
    }
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return null;
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  } else if (typeof value === "number") {
    const date = new Date(value);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  }
  return null;
}

function isAfter(
  targetDate: readonly [number, number, number] | Dayjs,
  referenceDate: readonly [number, number, number] | Dayjs,
): boolean {
  const [targetYear, targetMonth, targetDay] = isDayjs(targetDate)
    ? [targetDate.year(), targetDate.month() + 1, targetDate.date()]
    : targetDate;
  const [refYear, refMonth, refDay] = isDayjs(referenceDate)
    ? [referenceDate.year(), referenceDate.month() + 1, referenceDate.date()]
    : referenceDate;

  return (
    targetYear > refYear ||
    (targetYear === refYear && targetMonth > refMonth) ||
    (targetYear === refYear && targetMonth === refMonth && targetDay >= refDay)
  );
}

function isBefore(
  targetDate: [number, number, number],
  referenceDate: [number, number, number],
): boolean {
  const [targetYear, targetMonth, targetDay] = targetDate;
  const [refYear, refMonth, refDay] = referenceDate;

  return (
    targetYear < refYear ||
    (targetYear === refYear && targetMonth < refMonth) ||
    (targetYear === refYear && targetMonth === refMonth && targetDay <= refDay)
  );
}
