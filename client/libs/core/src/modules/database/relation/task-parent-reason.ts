// SPDX-License-Identifier: AGPL-3.0-or-later

import type { useI18n } from "@myoxus/i18n";

export function taskParentErrorReason(error: unknown): string | undefined {
  const extensions = (
    error as {
      extensions?: {
        code?: unknown;
        reason?: unknown;
        data?: { code?: unknown; reason?: unknown };
      };
    }
  )?.extensions;
  if (
    (extensions?.code ?? extensions?.data?.code) !==
    "MIX_DATABASE_TASK_RELATION_INVALID"
  )
    return undefined;
  const reason = extensions?.reason ?? extensions?.data?.reason;
  return typeof reason === "string" ? reason : undefined;
}

export function taskParentReason(
  t: ReturnType<typeof useI18n>,
  reason?: string,
) {
  switch (reason) {
    case "MissingRole":
    case "IncompatibleRoleConfiguration":
      return t["com.myoxus.database.task-parent.unavailable"]();
    case "SelfParent":
      return t["com.myoxus.database.task-parent.self"]();
    case "Cycle":
      return t["com.myoxus.database.task-parent.cycle"]();
    case "WrongRowKind":
      return t["com.myoxus.database.task-parent.wrong-kind"]();
    case "ForeignDatabase":
      return t["com.myoxus.database.task-parent.foreign-project"]();
    case "MultipleParents":
      return t["com.myoxus.database.task-parent.multiple"]();
    case "UnavailableTarget":
      return t["com.myoxus.database.task-parent.target-unavailable"]();
    default:
      return t["com.myoxus.database.task-parent.update-failed"]();
  }
}
