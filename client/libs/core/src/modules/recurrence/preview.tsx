// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  recurrencePreviewQuery,
  type RecurrenceRuleInput,
  type RecurrenceValueInput,
  type RecurrenceValueFieldsFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Button, Loading, MyoxusText, Notice, Stack } from "@myoxus/ui-facade";
import useSWR from "swr";
import type { Server } from "../server/entities/server";

/** Format a civil preview without interpreting it as a user-zone instant. */
export function formatRecurrenceValue(
  value: RecurrenceValueFieldsFragment,
  locale: string,
) {
  const date = value.date ?? value.localDateTime;
  if (!date) return "";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    dateStyle: "medium",
    ...(value.date ? {} : { timeStyle: "short" }),
  }).format(
    new Date(`${date.replace(" ", "T")}${value.date ? "T00:00:00" : ""}Z`),
  );
}

export function useRecurrencePreview(
  server: Server | null | undefined,
  identity: string | null,
  workspaceId: string,
  rule: RecurrenceRuleInput | null,
  completionReference?: RecurrenceValueInput | null,
  change?: { seriesId: string; expectedRevision: number },
) {
  return useSWR(
    server && identity && rule && (!rule.afterCompletion || completionReference)
      ? ([
          "recurrence-preview",
          identity,
          {
            workspaceId,
            input: {
              rule,
              count: 5,
              ...change,
              ...(rule.afterCompletion ? { completionReference } : {}),
            },
          },
        ] as const)
      : null,
    ([, , variables]) =>
      server!.gql({ query: recurrencePreviewQuery, variables }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
      shouldRetryOnError: false,
      revalidateOnFocus: false,
    },
  );
}

export function RecurrencePreview({
  result,
  conditional,
}: {
  result: ReturnType<typeof useRecurrencePreview>;
  conditional: boolean;
}) {
  const t = useI18n();
  const items = !result.error
    ? result.data?.workspace?.recurrencePreview
    : undefined;
  return (
    <Stack aria-live="polite">
      <MyoxusText>{t["com.myoxus.recurrence.preview"]()}</MyoxusText>
      {conditional ? (
        <MyoxusText tone="secondary">
          {t["com.myoxus.recurrence.conditional"]()}
        </MyoxusText>
      ) : null}
      {result.error ? (
        <Notice
          tone="warning"
          title={t["com.myoxus.recurrence.preview-failed"]()}
        >
          <Button onClick={() => void result.mutate()}>{t.Retry()}</Button>
        </Notice>
      ) : result.isLoading ? (
        <Loading />
      ) : items ? (
        items.length ? (
          items.map((item, index) => (
            <MyoxusText key={index}>
              {item.completionReference
                ? `${formatRecurrenceValue(item.completionReference, t.language)} → `
                : ""}
              {formatRecurrenceValue(item.occurrence.nominal, t.language)}
            </MyoxusText>
          ))
        ) : (
          <MyoxusText tone="secondary">
            {t["com.myoxus.recurrence.exhausted"]()}
          </MyoxusText>
        )
      ) : (
        <MyoxusText tone="secondary">
          {t["com.myoxus.recurrence.complete-rule"]()}
        </MyoxusText>
      )}
    </Stack>
  );
}
