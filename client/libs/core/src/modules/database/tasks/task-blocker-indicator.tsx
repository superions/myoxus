// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DatabaseTaskBlockerCounts } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Badge, Group } from "@myoxus/ui-facade";

import { taskBlockedByReason } from "../relation/task-blocked-by-reason";

/** Counts belong to the current SQL projection. Missing capability or unresolved
 * activity cannot be collapsed into a healthy zero, nor inferred from status. */
export function TaskBlockerIndicator({
  counts,
}: {
  counts: DatabaseTaskBlockerCounts | null | undefined;
}) {
  const t = useI18n();
  if (
    !counts?.available ||
    counts.activeCount == null ||
    counts.unresolvedCount == null
  ) {
    return (
      <Badge
        tone="warning"
        truncate
        title={
          counts?.diagnostics[0]
            ? taskBlockedByReason(t, counts.diagnostics[0])
            : t["com.myoxus.template-list.unavailable"]()
        }
      >
        {t["com.myoxus.template-list.unavailable"]()}
      </Badge>
    );
  }
  if (counts.activeCount === 0 && counts.unresolvedCount === 0) return null;
  const active = t["com.myoxus.database.task-blocking.active-count"]({
    count: counts.activeCount.toLocaleString(t.language),
  });
  const unresolved = t["com.myoxus.database.task-blocking.unresolved-count"]({
    count: counts.unresolvedCount.toLocaleString(t.language),
  });
  return (
    <Group>
      {counts.activeCount > 0 ? (
        <Badge truncate title={active} tone="warning">
          {active}
        </Badge>
      ) : null}
      {counts.unresolvedCount > 0 ? (
        <Badge truncate title={unresolved} tone="warning">
          {unresolved}
        </Badge>
      ) : null}
    </Group>
  );
}
