// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared Row activity rendering for Database collaboration surfaces.
//
// Query owners provide the authorized activity entries. This module renders
// them with stable i18n keys (`com.myoxus.database.activity.*`) and never
// translates the stored snake_case `event_type` column.

import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useI18n } from "@myoxus/i18n";
import {
  EmptyState,
  Loading,
  MyoxusText,
  TimelineList,
  TimelineListItem,
} from "@myoxus/ui-facade";
import { useMemo } from "react";

import type { DatabaseActivityEventType as DbActivityEventType } from "./database-activity-types";

export type DatabaseActivityEntryLike = {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  payload: Readonly<Record<string, unknown>> | null;
  createdAt: string;
};

export type DatabaseActivityListProps = {
  entries: ReadonlyArray<DatabaseActivityEntryLike>;
  loading: boolean;
  resolveEventTypeLabel: (
    eventType: string,
  ) => (typeof ACTIVITY_I18N_KEYS)[keyof typeof ACTIVITY_I18N_KEYS] | null;
  emptyDescription?: string;
  emptyTitle: string;
  label: string;
  testIdPrefix?: "database-activity" | "database-row-activity";
};

const ACTIVITY_I18N_KEYS = {
  "row.created": "com.myoxus.database.activity.created",
  "row.updated": "com.myoxus.database.activity.updated",
  "row.deleted": "com.myoxus.database.activity.deleted",
  "cell.changed": "com.myoxus.database.activity.cell_changed",
  "cell.cleared": "com.myoxus.database.activity.cell_cleared",
  "row.position_changed": "com.myoxus.database.activity.position_changed",
  "row.content_document_attached":
    "com.myoxus.database.activity.content_document_attached",
  "row.content_document_detached":
    "com.myoxus.database.activity.content_document_detached",
  "row.template_applied": "com.myoxus.database.activity.template_applied",
  "row.assignment_changed": "com.myoxus.database.activity.assignment_changed",
  "row.status_changed": "com.myoxus.database.activity.status_changed",
  "database.created": "com.myoxus.database.activity.database_created",
  "database.updated": "com.myoxus.database.activity.database_updated",
  "database.deleted": "com.myoxus.database.activity.database_deleted",
  "csv.import_completed": "com.myoxus.database.activity.import_completed",
  "json.import_completed": "com.myoxus.database.activity.import_completed",
  "csv.export_completed": "com.myoxus.database.activity.export_completed",
  "json.export_completed": "com.myoxus.database.activity.export_completed",
} as const;

export const ROW_ACTIVITY_I18N_KEYS = ACTIVITY_I18N_KEYS;

function activityMessage(
  t: ReturnType<typeof useI18n>,
  key: (typeof ACTIVITY_I18N_KEYS)[keyof typeof ACTIVITY_I18N_KEYS],
  actor: string,
  field: string,
  value: string,
) {
  if (key === "com.myoxus.database.activity.cell_changed") {
    return t[key]({ actor, field });
  }
  if (key === "com.myoxus.database.activity.cell_cleared") {
    return t[key]({ actor, field });
  }
  if (key === "com.myoxus.database.activity.status_changed") {
    return value
      ? t[key]({ actor, value })
      : t["com.myoxus.database.activity.cell_changed"]({ actor, field });
  }
  return t[key]({ actor });
}

/** Shared localized activity renderer for Row and Database context sections. */
export function DatabaseActivityList({
  emptyDescription,
  emptyTitle,
  entries,
  label,
  loading,
  resolveEventTypeLabel,
  testIdPrefix = "database-activity",
}: DatabaseActivityListProps) {
  const t = useI18n();
  const { formatDateTime } = useRegionalFormatters();
  const systemLabel = t["com.myoxus.database.activity.actor-system"]();
  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      if (a.createdAt < b.createdAt) return 1;
      if (a.createdAt > b.createdAt) return -1;
      return 0;
    });
  }, [entries]);

  if (loading) return <Loading />;
  if (!sortedEntries.length) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        data-testid={`${testIdPrefix}-empty`}
      />
    );
  }

  return (
    <TimelineList aria-label={label} data-testid={`${testIdPrefix}-list`}>
      {sortedEntries.map((entry) => {
        const i18nKey = resolveEventTypeLabel(entry.eventType);
        const key = i18nKey ?? "com.myoxus.database.activity.created";
        const actor =
          entry.actorDisplayName ??
          (entry.actorUserId ? entry.actorUserId : systemLabel);
        const fieldName =
          typeof entry.payload?.fieldName === "string"
            ? entry.payload.fieldName
            : "";
        const value =
          typeof entry.payload?.valueLabel === "string"
            ? entry.payload.valueLabel
            : typeof entry.payload?.value === "string"
              ? entry.payload.value
              : "";
        return (
          <TimelineListItem
            key={entry.id}
            title={
              <MyoxusText
                component="span"
                typographySlot="body-small"
                data-testid={`${testIdPrefix}-message`}
              >
                {activityMessage(t, key, actor, fieldName, value)}
              </MyoxusText>
            }
          >
            <MyoxusText
              component="span"
              tone="secondary"
              typographySlot="body-small"
              data-testid={`${testIdPrefix}-created-at`}
            >
              {formatDateTime(entry.createdAt)}
            </MyoxusText>
          </TimelineListItem>
        );
      })}
    </TimelineList>
  );
}

export type DatabaseActivityEventTypeKey = DbActivityEventType;
