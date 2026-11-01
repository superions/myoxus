// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseTaskSummaryFragment } from "@myoxus/graphql";

function calendarDay(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join("-");
}

/** All-day values retain their Cell calendar; timed values use the actor's
 * timezone. Overdue compares the same start point as the server Task query.
 */
export function presentTaskDue(
  due: DatabaseTaskSummaryFragment["due"],
  language: string,
  actorTimeZone: string,
  now = new Date(),
) {
  if (!due) return null;
  const start = new Date(due.start);
  return {
    label: new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      ...(due.allDay ? {} : { timeStyle: "short" as const }),
      timeZone: due.allDay ? due.timeZone : actorTimeZone,
    }).format(start),
    overdue: due.allDay
      ? calendarDay(start, due.timeZone) < calendarDay(now, actorTimeZone)
      : start < now,
  };
}
