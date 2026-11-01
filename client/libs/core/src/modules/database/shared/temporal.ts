// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseTimelineZoom } from "@myoxus/graphql";
import type {
  TemporalAxisModel,
  TemporalAxisLayoutInput,
} from "@myoxus/ui-facade";
import { getLocaleWeekStart } from "@myoxus/ui-facade";

export function databaseTemporalAxis(
  date: string,
  zoom: DatabaseTimelineZoom,
  locale: string,
): TemporalAxisModel & { step: number; zoom: Lowercase<DatabaseTimelineZoom> } {
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(start);
  const dayMs = 86_400_000;
  if (zoom === DatabaseTimelineZoom.Day) {
    end.setUTCDate(end.getUTCDate() + 1);
  } else if (zoom === DatabaseTimelineZoom.Week) {
    const offset = (start.getUTCDay() - getLocaleWeekStart(locale) + 7) % 7;
    start.setUTCDate(start.getUTCDate() - offset);
    end.setTime(start.getTime());
    end.setUTCDate(end.getUTCDate() + 7);
  } else if (zoom === DatabaseTimelineZoom.Month) {
    start.setUTCDate(1);
    end.setUTCFullYear(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
  } else if (zoom === DatabaseTimelineZoom.Quarter) {
    start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1);
    end.setUTCFullYear(start.getUTCFullYear(), start.getUTCMonth() + 3, 1);
  } else {
    start.setUTCMonth(0, 1);
    end.setUTCFullYear(start.getUTCFullYear() + 1, 0, 1);
  }
  return {
    end: end.getTime(),
    start: start.getTime(),
    step:
      zoom === DatabaseTimelineZoom.Day
        ? 3_600_000
        : zoom === DatabaseTimelineZoom.Week
          ? dayMs
          : zoom === DatabaseTimelineZoom.Year
            ? dayMs * 7
            : dayMs,
    zoom: zoom.toLowerCase() as Lowercase<DatabaseTimelineZoom>,
  };
}

export function databaseTemporalTicks(
  axis: TemporalAxisModel,
  locale: string,
  zoom: DatabaseTimelineZoom,
): Array<TemporalAxisLayoutInput["ticks"][number]> {
  const count = zoom === DatabaseTimelineZoom.Day ? 9 : 7;
  const formatter = new Intl.DateTimeFormat(locale, {
    ...(zoom === DatabaseTimelineZoom.Day
      ? { hour: "numeric" }
      : zoom === DatabaseTimelineZoom.Year
        ? { month: "short" }
        : { day: "numeric", month: "short" }),
    timeZone: "UTC",
  });
  return Array.from({ length: count }, (_, index) => {
    const value = axis.start + ((axis.end - axis.start) * index) / (count - 1);
    return { label: formatter.format(new Date(value)), value };
  });
}
