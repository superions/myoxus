// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

/** Public journal sidecard exports. */
import type { DocRecord } from "@myoxus/core/modules/doc";
import dayjs from "dayjs";

export { JournalActivityToolBody } from "./activity-tool";
export { JournalAgendaToolBody } from "./agenda-tool";
export { JournalCalendarToolBody } from "./calendar-tool";
export { JournalConflictBlock } from "./conflict-block";
export { JournalToolStateProvider, useJournalToolState } from "./tool-state";

export const sortPagesByDate = (
  docs: DocRecord[],
  field: "updatedDate" | "createDate",
  order: "asc" | "desc" = "desc",
) => {
  return [...docs].sort((a, b) => {
    return (
      (order === "asc" ? 1 : -1) *
      dayjs(b.meta$.value[field]).diff(dayjs(a.meta$.value[field]))
    );
  });
};
