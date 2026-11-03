// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  taskRecurrenceQuery,
  taskRecurrencesQuery,
  type QueryResponse,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { Button, FormSelect, Stack } from "@myoxus/ui-facade";
import { useRef, useState } from "react";
import useSWR from "swr";
import useSWRInfinite, {
  type SWRInfiniteConfiguration,
  type SWRInfiniteKeyLoader,
} from "swr/infinite";
import type { SWRFailureNotificationOptions } from "@myoxus/core/components/providers/swr-config-provider";
import { useTaskIdentity } from "../database/tasks/use-workspace-tasks";
import type { DatabaseChangeHandler } from "../database/shared";
import { TaskRecurrenceDialog } from "./task-recurrence";
import { recurrenceLifecycleLabel } from "./task-recurrence-members";

type SeriesPage = QueryResponse<typeof taskRecurrencesQuery>;
type SeriesKeyLoader = SWRInfiniteKeyLoader<
  SeriesPage,
  readonly [string, string, string | null] | null
>;
const listOptions: SWRInfiniteConfiguration<SeriesPage, Error> &
  SWRFailureNotificationOptions = {
  suspense: false,
  keepPreviousData: false,
  suppressErrorNotification: true,
  shouldRetryOnError: false,
  persistSize: false,
};

/** Retained native series are discoverable even when no current Task route can
 * be opened. Pagination and all readback remain workspace/account scoped. */
type ManagerProps = {
  onOpenTask: (database: string, row: string) => void;
  onChanged: DatabaseChangeHandler;
};

export function TaskRecurrenceManager(props: ManagerProps) {
  const owner = useTaskIdentity();
  // Late responses keep their original hook/cache owner after an identity
  // switch; bound SWR mutation callbacks must not target the new account.
  return <TaskRecurrenceManagerSession key={owner.identity} {...props} />;
}

function TaskRecurrenceManagerSession({ onOpenTask, onChanged }: ManagerProps) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const list = useSWRInfinite<SeriesPage, Error, SeriesKeyLoader>(
    (index, previous: QueryResponse<typeof taskRecurrencesQuery> | null) => {
      const entries = previous?.workspace?.taskRecurrences;
      if (
        !open ||
        !owner.server ||
        !owner.identity ||
        (index > 0 && entries?.length !== 20)
      )
        return null;
      return [
        "task-recurrence-list",
        owner.identity,
        index ? (entries?.at(-1)?.id ?? null) : null,
      ] as const;
    },
    ([, , after]) =>
      owner.server!.gql({
        query: taskRecurrencesQuery,
        variables: { workspaceId: owner.workspace.id, first: 20, after },
      }),
    listOptions,
  );
  const entries =
    list.data?.flatMap((page) => page.workspace?.taskRecurrences ?? []) ?? [];
  const id = selected ?? entries[0]?.id;
  const detail = useSWR(
    open && owner.server && owner.identity && id
      ? (["task-recurrence-series", owner.identity, id] as const)
      : null,
    ([, , seriesId]) =>
      owner.server!.gql({
        query: taskRecurrenceQuery,
        variables: {
          workspaceId: owner.workspace.id,
          input: { seriesId, rowId: undefined },
        },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
      shouldRetryOnError: false,
    },
  );
  return (
    <>
      <Button
        ref={trigger}
        disabled={!owner.server || !owner.identity}
        onClick={() => setOpen(true)}
      >
        {t["com.myoxus.recurrence.manage"]()}
      </Button>
      <TaskRecurrenceDialog
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        series={
          detail.error ? null : (detail.data?.workspace?.taskRecurrence ?? null)
        }
        error={Boolean(list.error || detail.error)}
        loading={list.isLoading || detail.isLoading}
        onRetry={() => {
          void list.mutate();
          void detail.mutate();
        }}
        onChanged={onChanged}
        onOpenTask={onOpenTask}
        selection={(disabled) => (
          <Stack>
            <FormSelect
              label={t["com.myoxus.recurrence.series"]()}
              value={id ?? null}
              disabled={disabled || list.isLoading}
              searchable
              allowDeselect={false}
              placeholder={t["com.myoxus.recurrence.empty"]()}
              data={entries.map((series) => ({
                value: series.id,
                label: `${series.recipe.title} · ${recurrenceLifecycleLabel(t, series.lifecycle)}`,
              }))}
              onChange={setSelected}
            />
            {list.data?.at(-1)?.workspace?.taskRecurrences.length === 20 ? (
              <Button
                disabled={disabled || list.isValidating}
                onClick={() => void list.setSize(list.size + 1)}
              >
                {t["com.myoxus.history.confirm-restore-modal.load-more"]()}
              </Button>
            ) : null}
          </Stack>
        )}
        onSaved={async (value) => {
          await detail.mutate(
            { workspace: { id: owner.workspace.id, taskRecurrence: value } },
            { revalidate: false },
          );
          await list.mutate(
            (pages) =>
              pages?.map((page) => ({
                ...page,
                workspace: page.workspace
                  ? {
                      ...page.workspace,
                      taskRecurrences: page.workspace.taskRecurrences.map(
                        (series) => (series.id === value.id ? value : series),
                      ),
                    }
                  : page.workspace,
              })),
            { revalidate: false },
          );
        }}
      />
    </>
  );
}
