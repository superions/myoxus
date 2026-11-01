// SPDX-License-Identifier: AGPL-3.0-or-later

import type { useI18n } from "@myoxus/i18n";
import { taskParentErrorReason } from "./task-parent-reason";

// The native error envelope is shared; only the actual property owner chooses
// its context-specific wording. Cycle never implies a Parent edit here.
export const taskBlockedByErrorReason = taskParentErrorReason;

export function taskBlockedByReason(
  t: ReturnType<typeof useI18n>,
  reason?: string,
) {
  switch (reason) {
    case "MissingRole":
    case "IncompatibleRoleConfiguration":
      return t["com.myoxus.database.task-blocked-by.unavailable"]();
    case "SelfBlockedBy":
      return t["com.myoxus.database.task-blocked-by.self"]();
    case "Cycle":
      return t["com.myoxus.database.task-blocked-by.cycle"]();
    case "WrongRowKind":
      return t["com.myoxus.database.task-blocked-by.wrong-kind"]();
    case "ForeignDatabase":
      return t["com.myoxus.database.task-blocked-by.foreign-project"]();
    case "DuplicateTargets":
      return t["com.myoxus.database.task-blocked-by.duplicates"]();
    case "UnavailableTarget":
      return t["com.myoxus.database.task-blocked-by.target-unavailable"]();
    default:
      return t["com.myoxus.database.task-blocked-by.update-failed"]();
  }
}
