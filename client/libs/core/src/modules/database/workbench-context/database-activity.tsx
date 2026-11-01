// SPDX-License-Identifier: AGPL-3.0-or-later

import { useQuery } from "@myoxus/core/components/hooks/use-query";
import { databaseActivityQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Button, EmptyState } from "@myoxus/ui-facade";

import { DatabaseActivityList, ROW_ACTIVITY_I18N_KEYS } from "../row-activity";

const DATABASE_ACTIVITY_QUERY_CONFIG = {
  suspense: false,
  suppressErrorNotification: true,
} as const;

/** Database-scoped audit stream backed by `workspace.databaseActivity`. */
export function DatabaseActivityPanel({
  databaseId,
  workspaceId,
}: {
  databaseId: string;
  workspaceId: string;
}) {
  const t = useI18n();
  const { data, error, isLoading, mutate } = useQuery(
    {
      query: databaseActivityQuery,
      variables: {
        databaseId,
        workspaceId,
        skip: 0,
        take: 50,
      },
    },
    DATABASE_ACTIVITY_QUERY_CONFIG,
  );

  if (error) {
    return (
      <EmptyState
        title={t["com.myoxus.common.operation-failed"]()}
        cta={<Button onClick={() => void mutate()}>{t["Retry"]()}</Button>}
      />
    );
  }

  const entries = (data?.workspace?.databaseActivity ?? []).map((entry) => ({
    actorDisplayName: entry.actorDisplayName ?? null,
    actorUserId: entry.actorUserId ?? null,
    createdAt: entry.createdAt,
    eventType: entry.eventType,
    id: entry.id,
    payload:
      entry.payload && typeof entry.payload === "object"
        ? (entry.payload as Readonly<Record<string, unknown>>)
        : null,
  }));

  return (
    <DatabaseActivityList
      emptyTitle={t["com.myoxus.database.activity.drawer-empty"]()}
      entries={entries}
      label={t["com.myoxus.sidebar.tab.activity"]()}
      loading={isLoading}
      resolveEventTypeLabel={(eventType) =>
        ROW_ACTIVITY_I18N_KEYS[
          eventType as keyof typeof ROW_ACTIVITY_I18N_KEYS
        ] ?? null
      }
    />
  );
}
