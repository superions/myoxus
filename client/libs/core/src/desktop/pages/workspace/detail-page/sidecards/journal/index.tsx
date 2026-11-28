// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { DocRecord } from "@myoxus/core/modules/doc";
import dayjs from "dayjs";

export { JournalActivityToolBody } from "./activity-tool";
export { JournalAgendaToolBody } from "./agenda-tool";
export { JournalCalendarToolBody } from "./calendar-tool";
export { JournalConflictBlock } from "./conflict-block";
export { JournalToolStateProvider, useJournalToolState } from "./tool-state";

export function sortPagesByDate(
  docs: readonly DocRecord[],
  field: "updatedDate" | "createDate",
  order: "asc" | "desc" = "desc",
): DocRecord[] {
  const direction = order === "asc" ? 1 : -1;
  return [...docs].sort(
    (left, right) =>
      direction *
      dayjs(right.meta$.value[field]).diff(dayjs(left.meta$.value[field])),
  );
}
