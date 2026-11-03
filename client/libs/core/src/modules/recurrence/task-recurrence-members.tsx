// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  databaseTaskReferencesQuery,
  DatabaseTaskReferenceState,
  RecurrenceLifecycle,
  type TaskRecurrenceFieldsFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Badge, Button, Loading, MyoxusText, Stack } from "@myoxus/ui-facade";
import useSWR from "swr";
import { useTaskIdentity } from "../database/tasks/use-workspace-tasks";
import { formatRecurrenceValue } from "./preview";

type Translator = ReturnType<typeof useI18n>;

export function recurrenceLifecycleLabel(
  t: Translator,
  value: RecurrenceLifecycle,
) {
  switch (value) {
    case RecurrenceLifecycle.Active:
      return t["com.myoxus.recurrence.active"]();
    case RecurrenceLifecycle.Paused:
      return t["com.myoxus.recurrence.paused"]();
    case RecurrenceLifecycle.Ended:
      return t["com.myoxus.recurrence.ended"]();
  }
}

export function recurrenceUnavailableLabel(t: Translator, reason: string) {
  switch (reason) {
    case "taskPermissionUnavailable":
      return t["com.myoxus.recurrence.permission-unavailable"]();
    case "taskDestinationUnavailable":
      return t["com.myoxus.recurrence.destination-unavailable"]();
    case "taskSourceUnavailable":
      return t["com.myoxus.recurrence.source-unavailable"]();
    case "taskRecipeUnavailable":
      return t["com.myoxus.recurrence.recipe-unavailable"]();
    case "taskRuntimeUnavailable":
      return t["com.myoxus.recurrence.runtime-unavailable"]();
    default:
      return t["com.myoxus.recurrence.unavailable"]();
  }
}

/** Historical slots are displayed as captured. Current labels and navigation
 * come only from native reference resolution, never the captured container ID. */
export function TaskRecurrenceMembers({
  series,
  rowId,
  onOpenTask,
  showNext = true,
}: {
  series: TaskRecurrenceFieldsFragment;
  rowId?: string;
  onOpenTask?: (database: string, row: string) => void;
  showNext?: boolean;
}) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const selected = rowId
    ? series.members.find((member) => member.rowId === rowId)
    : (series.members.find((member) => member.id === series.currentMemberId) ??
      series.members[0]);
  const roles = [
    { member: selected, label: t["com.myoxus.recurrence.member"]() },
    {
      member: series.preservedNext,
      label: t["com.myoxus.recurrence.preserved-next"](),
    },
    {
      member: series.effectiveAfter,
      label: t["com.myoxus.recurrence.effective-after"](),
    },
  ].flatMap((entry) =>
    entry.member ? [{ member: entry.member, label: entry.label }] : [],
  );
  const byMember = new Map<string, (typeof roles)[number]>();
  for (const role of roles) {
    const existing = byMember.get(role.member.id);
    byMember.set(
      role.member.id,
      existing ? { ...role, label: `${existing.label} · ${role.label}` } : role,
    );
  }
  const summaries = [...byMember.values()];
  const targets = summaries.map(({ member }) => ({
    databaseId: member.capturedDatabaseId,
    rowId: member.rowId,
    workspaceId: owner.workspace.id,
  }));
  const references = useSWR(
    owner.server && owner.identity && targets.length
      ? (["recurrence-member-references", owner.identity, targets] as const)
      : null,
    ([, , targets]) =>
      owner.server!.gql({
        query: databaseTaskReferencesQuery,
        variables: { workspaceId: owner.workspace.id, targets },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
      shouldRetryOnError: false,
    },
  );
  return (
    <Stack>
      {summaries.map(({ member, label }) => {
        const resolved = !references.error
          ? references.data?.workspace?.databaseTaskReferences.find(
              (target) => target.rowId === member.rowId,
            )
          : undefined;
        const reference = resolved?.task;
        return (
          <Stack key={member.id}>
            <MyoxusText tone="secondary">{label}</MyoxusText>
            {references.isLoading ? (
              <Loading />
            ) : reference && onOpenTask ? (
              <Button
                variant="plain"
                onClick={() =>
                  onOpenTask(reference.databaseId, reference.rowId)
                }
              >
                {reference.title}
              </Button>
            ) : (
              <MyoxusText>
                {reference?.title ??
                  t["com.myoxus.database.row_detail.unavailable"]()}
              </MyoxusText>
            )}
            {resolved?.state === DatabaseTaskReferenceState.Trashed ? (
              <Badge>{t.Trash()}</Badge>
            ) : null}
            {member.slot ? (
              <MyoxusText>
                {formatRecurrenceValue(member.slot.nominal, t.language)}
              </MyoxusText>
            ) : null}
            {member.advanceKind ? (
              <MyoxusText tone="secondary">
                {member.advanceKind === "skip"
                  ? t["com.myoxus.recurrence.skipped"]()
                  : t["com.myoxus.common.status.completed"]()}
              </MyoxusText>
            ) : null}
          </Stack>
        );
      })}
      {showNext && series.next && !series.effectiveAfter ? (
        <MyoxusText>
          {t["com.myoxus.recurrence.next-due"]({
            date: formatRecurrenceValue(series.next.nominal, t.language),
          })}
        </MyoxusText>
      ) : null}
      {showNext && series.next && series.effectiveAfter ? (
        <MyoxusText>
          {t["com.myoxus.recurrence.first-affected"]({
            date: formatRecurrenceValue(series.next.nominal, t.language),
          })}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}
