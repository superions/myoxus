// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import {
  configureTaskRecurrenceMutation,
  databaseSchemaQuery,
  endTaskRecurrenceMutation,
  pauseTaskRecurrenceMutation,
  resumeTaskRecurrenceMutation,
  skipTaskRecurrenceMutation,
  updateTaskRecurrenceMutation,
  RecurrenceLifecycle,
  RecurrenceFrequency,
  RecurrenceMode,
  RecurrenceRelativeUnit,
  RecurrenceWeekday,
  taskRecurrenceQuery,
  type TaskRecurrenceFieldsFragment,
  type TaskRecurrenceRecipeInput,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  FormRow,
  FormSelect,
  Group,
  Input,
  Loading,
  Modal,
  MyoxusText,
  Notice,
  RichTextInput,
  Stack,
  type MyoxusRichTextDocument,
} from "@myoxus/ui-facade";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useLiveData, useService } from "@myoxus/infra";
import { GuardService } from "../permissions";
import useSWR from "swr";
import { managedTaskFields } from "../database/managed";
import { getCellValue } from "../database/model";
import { taskOptionDisplayName } from "../database/presentation/task-labels";
import type { DatabaseChangeHandler } from "../database/shared";
import { databaseZonedDateTime } from "../database/shared/schedule";
import {
  useTaskDestinations,
  useTaskIdentity,
} from "../database/tasks/use-workspace-tasks";
import type { DatabaseRecord, DatabaseRowRecord } from "../database/types";
import {
  formatRecurrenceValue,
  RecurrencePreview,
  useRecurrencePreview,
} from "./preview";
import {
  TaskRecurrenceMembers,
  recurrenceLifecycleLabel,
  recurrenceUnavailableLabel,
} from "./task-recurrence-members";
import {
  recurrenceDraft,
  recurrenceRule,
  recurrenceValue,
  RecurrenceRuleFields,
  type RecurrenceDraft,
} from "./rule-fields";

type Props = {
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  canConfigure: boolean;
  onChanged: DatabaseChangeHandler;
  onEditOccurrence?: () => void;
  onOpenTask?: (databaseId: string, rowId: string) => void;
  onRequestOpen?: (open: () => void) => void;
};

export function TaskRecurrenceControl(props: Props) {
  const owner = useTaskIdentity();
  return <TaskRecurrenceControlSession key={owner.identity} {...props} />;
}

function TaskRecurrenceControlSession(props: Props) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const query = useSWR(
    owner.server && owner.identity
      ? (["task-recurrence", owner.identity, props.row.row.id] as const)
      : null,
    () =>
      owner.server!.gql({
        query: taskRecurrenceQuery,
        variables: {
          workspaceId: owner.workspace.id,
          input: { rowId: props.row.row.id, seriesId: undefined },
        },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
      shouldRetryOnError: false,
    },
  );
  const series = !query.error
    ? query.data?.workspace?.taskRecurrence
    : undefined;
  const revision = JSON.stringify([
    props.row.row.editRevision,
    props.row.cellRevisions,
  ]);
  const observedRevision = useRef(revision);
  useEffect(() => {
    // Re-keying on a Cell update would unmount the open draft and silently
    // replace its captured edit basis. Read changed members only after close.
    if (!open && observedRevision.current !== revision) {
      observedRevision.current = revision;
      void query.mutate();
    }
  }, [open, revision, query.mutate]);
  return (
    <>
      <Button
        ref={trigger}
        variant="plain"
        disabled={
          !owner.server ||
          !owner.identity ||
          query.isLoading ||
          query.isValidating ||
          (!props.canConfigure && !series && !query.error)
        }
        onClick={() => {
          const open = () => {
            void query.mutate().then(
              () => setOpen(true),
              () => setOpen(true),
            );
          };
          if (props.onRequestOpen) props.onRequestOpen(open);
          else open();
        }}
      >
        {t["com.myoxus.recurrence.repeat"]()}
      </Button>
      <TaskRecurrenceDialog
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        source={props}
        onOpenTask={props.onOpenTask}
        series={series ?? null}
        error={Boolean(query.error)}
        loading={query.isLoading}
        onRetry={() => void query.mutate()}
        onSaved={async (value) => {
          // A successful mutation is authoritative even when a later Row refresh
          // fails. Keep the accepted association instead of inviting re-adoption.
          await query.mutate(
            {
              workspace: {
                id: owner.workspace.id,
                taskRecurrence: value,
              },
            },
            { revalidate: false },
          );
        }}
      />
    </>
  );
}

/** One native recurrence Modal for a Task entry or the workspace series list.
 * Only native controls use current workspace authority; no assistance package
 * or synthetic actor participates in these commands. */
export function TaskRecurrenceDialog({
  open,
  onOpenChange,
  returnFocusRef,
  source,
  series,
  error,
  loading,
  onRetry,
  onSaved,
  selection,
  onOpenTask,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  source?: Props;
  series: TaskRecurrenceFieldsFragment | null;
  error?: boolean;
  loading?: boolean;
  onRetry: () => void;
  onSaved: (value: TaskRecurrenceFieldsFragment) => Promise<void>;
  selection?: (disabled: boolean) => ReactNode;
  onOpenTask?: (databaseId: string, rowId: string) => void;
  onChanged?: DatabaseChangeHandler;
}) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const canManage = Boolean(
    useLiveData(useService(GuardService).can$("Workspace_CreateDoc")),
  );
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const afterClose = useRef<(() => void) | null>(null);
  const leave = (action: () => void) => {
    afterClose.current = action;
    onOpenChange(false);
  };
  return (
    <Modal
      open={open}
      persistent={pending}
      onOpenChange={(value) => {
        if (!pending) onOpenChange(value);
      }}
      title={
        selection
          ? t["com.myoxus.recurrence.manage"]()
          : t["com.myoxus.recurrence.repeat"]()
      }
      scrollable
      returnFocusRef={returnFocusRef}
      onExitTransitionEnd={() => {
        // The Facade restores its durable opener first; native Task navigation
        // can then retain that connected toolbar/detail trigger for its return.
        const action = afterClose.current;
        afterClose.current = null;
        action?.();
      }}
    >
      {selection?.(pending || editing)}
      {open ? (
        error ? (
          <Notice
            tone="warning"
            title={t["com.myoxus.recurrence.unavailable"]()}
          >
            <Button onClick={onRetry}>{t.Retry()}</Button>
          </Notice>
        ) : loading ? (
          <Loading />
        ) : owner.server && owner.identity && (source || series) ? (
          <TaskRecurrenceSession
            key={`${owner.identity}:${source?.row.row.id ?? series?.id}`}
            {...source}
            series={series}
            onChanged={source?.onChanged ?? onChanged}
            canManage={canManage}
            pending={pending}
            setPending={setPending}
            onEditingChange={setEditing}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
            onEditOccurrence={
              source?.onEditOccurrence
                ? () => leave(source.onEditOccurrence!)
                : undefined
            }
            onOpenTask={
              onOpenTask
                ? (database, row) => leave(() => onOpenTask(database, row))
                : undefined
            }
          />
        ) : null
      ) : null}
    </Modal>
  );
}

function TaskRecurrenceSession({
  record,
  row,
  canConfigure,
  series,
  onChanged,
  onClose,
  onSaved,
  pending,
  setPending,
  canManage,
  onEditingChange,
  onEditOccurrence,
  onOpenTask,
}: Partial<Props> & {
  series: TaskRecurrenceFieldsFragment | null;
  onClose: () => void;
  onSaved: (value: TaskRecurrenceFieldsFragment) => Promise<void>;
  pending: boolean;
  setPending: (value: boolean) => void;
  canManage: boolean;
  onEditingChange: (value: boolean) => void;
  onOpenTask?: (databaseId: string, rowId: string) => void;
}) {
  const t = useI18n();
  const regional = useRegionalPreferences();
  const owner = useTaskIdentity();
  const destinations = useTaskDestinations();
  const fields = managedTaskFields(record);
  const dueField = fields?.get("task.dueDate");
  const due =
    dueField && row ? getCellValue(row, dueField.id)?.value.dateTime : null;
  const zone = series?.rule.zone || due?.timeZone || regional.timezone;
  const reference = databaseZonedDateTime(
    new Date().toISOString(),
    zone,
  ).replace(" ", "T");
  // Capture the native edit basis once per explicit opening. Background Row
  // delivery must not silently turn an old draft into a new confirmed revision.
  const [basis] = useState(() => ({
    row: row?.row.editRevision,
    due:
      row?.cellRevisions.find((cell) => cell.fieldId === dueField?.id)
        ?.editRevision ?? 0,
  }));
  const [draft, setDraft] = useState<RecurrenceDraft>(() =>
    series
      ? recurrenceDraft(
          series.rule,
          series.rule.dateOnly ? reference.slice(0, 10) : reference,
        )
      : {
          mode: RecurrenceMode.Fixed,
          frequency: RecurrenceFrequency.Daily,
          interval: 1,
          unit: RecurrenceRelativeUnit.Days,
          dateOnly: due?.allDay ?? false,
          start: due
            ? due.allDay
              ? due.start.slice(0, 10)
              : databaseZonedDateTime(due.start, zone).replace(" ", "T")
            : reference,
          end: "",
          zone,
          weekdays: [RecurrenceWeekday.Monday],
          day: 1,
          month: 1,
          lastDay: false,
          completionReference: due?.allDay ? reference.slice(0, 10) : reference,
        },
  );
  const [recipe, setRecipe] = useState<TaskRecurrenceRecipeInput>(() => {
    if (series)
      return {
        ...series.recipe,
        description: series.recipe.description
          ? { document: series.recipe.description.document }
          : null,
      };
    const cell = (role: string) => {
      const field = fields?.get(role);
      return field && row ? getCellValue(row, field.id)?.value : null;
    };
    return {
      databaseId: record?.database.id ?? "",
      title: row?.row.title ?? "",
      description: cell("task.description")?.richText
        ? { document: cell("task.description")!.richText!.document }
        : null,
      assignees: cell("task.assignees")?.users ?? [],
      priority: cell("task.priority")?.select ?? null,
    };
  });
  const [failure, setFailure] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [confirmed, setConfirmed] = useState(series);
  const [editing, setEditing] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    onConfirm: () => Promise<void>;
  } | null>(null);
  // Confirm in this frame: the global dialog host can belong to another
  // Mantine stack and appear behind an already open native rule Modal.
  const confirmAction = (value: {
    title: string;
    description: string;
    confirmText: string;
    onConfirm: () => Promise<void>;
  }) => setConfirmation(value);
  useEffect(() => {
    onEditingChange(editing);
    return () => onEditingChange(false);
  }, [editing, onEditingChange]);
  const ended = confirmed?.lifecycle === RecurrenceLifecycle.Ended;
  const readonly =
    (confirmed ? !editing || !canManage || ended : !canConfigure) || accepted;
  const rule = recurrenceRule(draft);
  const preview = useRecurrencePreview(
    owner.server,
    owner.identity,
    owner.workspace.id,
    ended ? null : rule,
    recurrenceValue(draft.completionReference, draft.dateOnly),
    confirmed
      ? { seriesId: confirmed.id, expectedRevision: confirmed.revision }
      : undefined,
  );
  // A checked empty edit preview is finite exhaustion, not an invalid rule.
  const previewReady =
    !preview.error &&
    !preview.isLoading &&
    Boolean(
      preview.data?.workspace &&
      (confirmed || preview.data.workspace.recurrencePreview.length),
    );
  const changeRecipe = (value: Partial<TaskRecurrenceRecipeInput>) =>
    setRecipe((current) => ({ ...current, ...value }));
  const destination = useSWR(
    owner.server &&
      owner.identity &&
      recipe.databaseId &&
      record?.database.id !== recipe.databaseId
      ? ([
          "recurrence-recipe-schema",
          owner.identity,
          recipe.databaseId,
        ] as const)
      : null,
    ([, , databaseId]) =>
      owner.server!.gql({
        query: databaseSchemaQuery,
        variables: { workspaceId: owner.workspace.id, databaseId },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
      shouldRetryOnError: false,
    },
  );
  const priorityField = managedTaskFields(
    record?.database.id === recipe.databaseId
      ? record
      : destination.data?.workspace?.database,
  )?.get("task.priority");
  const reload = async () => {
    if (!confirmed || !owner.server || pending || editing) return;
    setPending(true);
    setRefreshFailed(false);
    try {
      const response = await owner.server.gql({
        query: taskRecurrenceQuery,
        variables: {
          workspaceId: owner.workspace.id,
          input: row
            ? { rowId: row.row.id, seriesId: undefined }
            : { seriesId: confirmed.id, rowId: undefined },
        },
      });
      const value = response.workspace?.taskRecurrence;
      if (!value) throw new Error("Native recurrence unavailable");
      setConfirmed(value);
      setFailure(false);
      setAccepted(false);
      setDraft(
        recurrenceDraft(
          value.rule,
          value.rule.dateOnly ? reference.slice(0, 10) : reference,
        ),
      );
      setRecipe({
        ...value.recipe,
        description: value.recipe.description
          ? { document: value.recipe.description.document }
          : null,
      });
      await onSaved(value);
    } catch {
      setRefreshFailed(true);
    }
    setPending(false);
  };
  const apply = async (
    effect: () => Promise<TaskRecurrenceFieldsFragment>,
    close = false,
  ) => {
    if (pending || accepted) return;
    setPending(true);
    setFailure(false);
    let value: TaskRecurrenceFieldsFragment;
    try {
      value = await effect();
    } catch {
      setFailure(true);
      setPending(false);
      return;
    }
    setConfirmed(value);
    setDraft(
      recurrenceDraft(
        value.rule,
        value.rule.dateOnly ? reference.slice(0, 10) : reference,
      ),
    );
    setRecipe({
      ...value.recipe,
      description: value.recipe.description
        ? { document: value.recipe.description.document }
        : null,
    });
    setEditing(false);
    try {
      await onSaved(value);
      await onChanged?.({
        kind: "row_updated",
        target: row ? { rowId: row.row.id } : undefined,
      });
    } catch {
      setAccepted(true);
      setFailure(true);
      setPending(false);
      return;
    }
    setPending(false);
    if (close) onClose();
  };
  const lifecycle = async (action: "pause" | "resume" | "end") => {
    if (!confirmed || !owner.server || !canManage) return;
    const variables = {
      input: {
        workspaceId: owner.workspace.id,
        seriesId: confirmed.id,
        expectedRevision: confirmed.revision,
      },
    };
    await apply(async () => {
      if (action === "pause")
        return (
          await owner.server!.gql({
            query: pauseTaskRecurrenceMutation,
            variables,
          })
        ).pauseTaskRecurrence;
      if (action === "resume")
        return (
          await owner.server!.gql({
            query: resumeTaskRecurrenceMutation,
            variables,
          })
        ).resumeTaskRecurrence;
      return (
        await owner.server!.gql({ query: endTaskRecurrenceMutation, variables })
      ).endTaskRecurrence;
    });
  };
  const member = confirmed?.members.find(
    (member) => member.rowId === row?.row.id,
  );
  const skip = () => {
    if (
      !confirmed ||
      !member ||
      !row ||
      !owner.server ||
      !canConfigure ||
      ended ||
      member.advancedAt
    )
      return;
    const status = fields?.get("task.status");
    const expectedStatusRevision =
      row.cellRevisions.find((cell) => cell.fieldId === status?.id)
        ?.editRevision ?? 0;
    // Confirm the member's first-write receipt, not another guessed occurrence.
    confirmAction({
      title: t["com.myoxus.recurrence.skip"](),
      description: t["com.myoxus.recurrence.skip-confirm"](),
      confirmText: t["com.myoxus.recurrence.skip"](),
      onConfirm: () =>
        apply(
          async () =>
            (
              await owner.server!.gql({
                query: skipTaskRecurrenceMutation,
                variables: {
                  input: {
                    workspaceId: owner.workspace.id,
                    seriesId: confirmed.id,
                    memberId: member.id,
                    expectedRevision: confirmed.revision,
                    expectedRowRevision: row.row.editRevision,
                    expectedStatusRevision,
                  },
                },
              })
            ).skipTaskRecurrence,
        ),
    });
  };
  const save = async () => {
    if (!rule || !owner.server || readonly || pending || !previewReady) return;
    if (confirmed) {
      await apply(
        async () =>
          (
            await owner.server!.gql({
              query: updateTaskRecurrenceMutation,
              variables: {
                input: {
                  workspaceId: owner.workspace.id,
                  seriesId: confirmed.id,
                  expectedRevision: confirmed.revision,
                  rule,
                  recipe,
                },
              },
            })
          ).updateTaskRecurrence,
      );
      return;
    }
    if (!record || !row || basis.row === undefined) return;
    setPending(true);
    setFailure(false);
    let saved: TaskRecurrenceFieldsFragment;
    try {
      const response = await owner.server.gql({
        query: configureTaskRecurrenceMutation,
        variables: {
          input: {
            workspaceId: owner.workspace.id,
            databaseId: record.database.id,
            rowId: row.row.id,
            expectedRowRevision: basis.row,
            expectedDueRevision: basis.due,
            rule,
            recipe,
          },
        },
      });
      saved = response.configureTaskRecurrence;
    } catch {
      setFailure(true);
      setPending(false);
      return;
    }
    setAccepted(true);
    await onSaved(saved);
    try {
      await onChanged?.({ kind: "row_updated", target: { rowId: row.row.id } });
    } catch {
      setFailure(true);
      setPending(false);
      return;
    }
    setPending(false);
    onClose();
  };
  if (confirmation)
    return (
      <Stack>
        <MyoxusText>{confirmation.title}</MyoxusText>
        <MyoxusText>{confirmation.description}</MyoxusText>
        {failure ? (
          <Notice
            tone="warning"
            title={t["com.myoxus.recurrence.save-failed"]()}
          />
        ) : null}
        <Group justify="flex-end">
          <Button
            disabled={pending}
            onClick={() => {
              setConfirmation(null);
              setFailure(false);
            }}
          >
            {t.Cancel()}
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              void confirmation.onConfirm().then(() => setConfirmation(null))
            }
          >
            {confirmation.title}
          </Button>
        </Group>
      </Stack>
    );
  return (
    <Stack>
      {confirmed ? (
        <Stack>
          <MyoxusText>
            {recurrenceLifecycleLabel(t, confirmed.lifecycle)}
          </MyoxusText>
          {confirmed.blockedReason ? (
            <Notice
              tone="warning"
              title={recurrenceUnavailableLabel(t, confirmed.blockedReason)}
            >
              <Button
                disabled={pending || editing}
                onClick={() => void reload()}
              >
                {t.Retry()}
              </Button>
            </Notice>
          ) : null}
          <TaskRecurrenceMembers
            series={confirmed}
            showNext={!editing}
            rowId={row?.row.id}
            onOpenTask={editing ? undefined : onOpenTask}
          />
          {row ? (
            <Group>
              {onEditOccurrence ? (
                <Button
                  disabled={pending || editing || !canManage}
                  onClick={onEditOccurrence}
                >
                  {t["com.myoxus.recurrence.edit-occurrence"]()}
                </Button>
              ) : null}
              {!ended && !member?.advancedAt ? (
                <Button
                  disabled={pending || editing || !canConfigure || !member}
                  onClick={skip}
                >
                  {t["com.myoxus.recurrence.skip"]()}
                </Button>
              ) : null}
            </Group>
          ) : null}
          {!editing ? (
            <Group>
              <Button disabled={pending} onClick={() => void reload()}>
                {t["com.myoxus.database.conflict.reload"]()}
              </Button>
              {canManage && !ended ? (
                <>
                  <Button
                    disabled={pending || accepted}
                    onClick={() => {
                      setDraft(
                        recurrenceDraft(
                          confirmed.rule,
                          confirmed.rule.dateOnly
                            ? reference.slice(0, 10)
                            : reference,
                        ),
                      );
                      setRecipe({
                        ...confirmed.recipe,
                        description: confirmed.recipe.description
                          ? { document: confirmed.recipe.description.document }
                          : null,
                      });
                      setEditing(true);
                    }}
                  >
                    {t["com.myoxus.recurrence.edit-series"]()}
                  </Button>
                  <Button
                    disabled={pending || accepted}
                    onClick={() =>
                      void lifecycle(
                        confirmed.lifecycle === RecurrenceLifecycle.Paused
                          ? "resume"
                          : "pause",
                      )
                    }
                  >
                    {confirmed.lifecycle === RecurrenceLifecycle.Paused
                      ? t["com.myoxus.recurrence.resume"]()
                      : t["com.myoxus.recurrence.pause"]()}
                  </Button>
                  <Button
                    disabled={pending || accepted}
                    onClick={() =>
                      confirmAction({
                        title: t["com.myoxus.recurrence.end-series"](),
                        description: t["com.myoxus.recurrence.end-confirm"](),
                        confirmText: t["com.myoxus.recurrence.end-series"](),
                        onConfirm: () => lifecycle("end"),
                      })
                    }
                  >
                    {t["com.myoxus.recurrence.end-series"]()}
                  </Button>
                </>
              ) : null}
            </Group>
          ) : null}
        </Stack>
      ) : null}
      <MyoxusText tone="secondary">
        {t["com.myoxus.recurrence.task-hint"]()}
      </MyoxusText>
      <RecurrenceRuleFields
        value={draft}
        onChange={(next) => {
          // Relative kind comes from the adopted native Due, never a temporary
          // All day toggle made while exploring fixed mode in this draft.
          if (next.mode === RecurrenceMode.AfterCompletion) {
            const dateOnly = series?.rule.dateOnly ?? due?.allDay ?? false;
            const value = next.completionReference;
            next = {
              ...next,
              dateOnly,
              completionReference: dateOnly
                ? value.slice(0, 10)
                : value.length === 10
                  ? `${value}T09:00:00`
                  : value,
            };
          }
          setDraft(next);
        }}
        disabled={readonly || pending}
      />
      {!ended ? (
        <RecurrencePreview
          result={preview}
          conditional={draft.mode === RecurrenceMode.AfterCompletion}
        />
      ) : null}
      {editing &&
      draft.mode === RecurrenceMode.Fixed &&
      previewReady &&
      Boolean(preview.data?.workspace?.recurrencePreview.length) ? (
        <MyoxusText>
          {t["com.myoxus.recurrence.first-affected"]({
            date: formatRecurrenceValue(
              preview.data!.workspace!.recurrencePreview[0]!.occurrence.nominal,
              t.language,
            ),
          })}
        </MyoxusText>
      ) : null}
      <MyoxusText>{t["com.myoxus.recurrence.recipe"]()}</MyoxusText>
      <FormSelect
        label={t["com.myoxus.database.template.profile.project"]()}
        value={recipe.databaseId}
        searchable
        allowDeselect={false}
        disabled={readonly || pending || destinations.isLoading}
        data={[
          ...destinations.readyDestinations.map((destination) => ({
            value: destination.id,
            label: destination.workspaceTasks
              ? t["com.myoxus.common.without-project"]()
              : destination.title,
          })),
          ...(!destinations.readyDestinations.some(
            (destination) => destination.id === recipe.databaseId,
          ) && recipe.databaseId
            ? [
                {
                  value: recipe.databaseId,
                  label: t["com.myoxus.database.row_detail.unavailable"](),
                  disabled: true,
                },
              ]
            : []),
        ]}
        onChange={(databaseId) => changeRecipe({ databaseId })}
      />
      {destinations.destinationError ? (
        <Notice tone="warning" title={t["com.myoxus.recurrence.unavailable"]()}>
          <Button onClick={() => void destinations.mutate()}>
            {t.Retry()}
          </Button>
        </Notice>
      ) : null}
      {destinations.nextCursor ? (
        <Button
          onClick={() => void destinations.loadMore()}
          disabled={destinations.isLoadingMore}
        >
          {t["com.myoxus.history.confirm-restore-modal.load-more"]()}
        </Button>
      ) : null}
      <Input
        label={t.Title()}
        value={recipe.title}
        onChange={(title) => changeRecipe({ title })}
        disabled={readonly || pending}
        required
      />
      <FormRow label={t["com.myoxus.common.description"]()}>
        <RichTextInput
          aria-label={t["com.myoxus.common.description"]()}
          readOnly={readonly || pending}
          value={
            (recipe.description?.document ?? {
              type: "doc",
              content: [{ type: "paragraph" }],
            }) as MyoxusRichTextDocument
          }
          onChange={(document) => changeRecipe({ description: { document } })}
        />
      </FormRow>
      <FormRow label={t["com.myoxus.database.property.assignees"]()}>
        <MemberSelectorInline
          selected={recipe.assignees}
          readonly={readonly || pending}
          onChange={(assignees) => changeRecipe({ assignees })}
        />
      </FormRow>
      <FormSelect
        label={t["com.myoxus.database.property.priority"]()}
        value={recipe.priority ?? null}
        disabled={readonly || pending}
        clearable
        data={[
          ...(priorityField?.config.select?.options ?? []).map((option) => ({
            value: option.id,
            label: taskOptionDisplayName(t, "task.priority", option.id),
          })),
          ...(recipe.priority &&
          !(priorityField?.config.select?.options ?? []).some(
            (option) => option.id === recipe.priority,
          )
            ? [
                {
                  value: recipe.priority,
                  label: t["com.myoxus.database.row_detail.unavailable"](),
                  disabled: true,
                },
              ]
            : []),
        ]}
        onChange={(priority) => changeRecipe({ priority })}
        onClear={() => changeRecipe({ priority: null })}
      />
      {failure ? (
        <Notice
          tone="warning"
          title={
            accepted
              ? t["com.myoxus.recurrence.saved-refresh"]()
              : t["com.myoxus.recurrence.save-failed"]()
          }
        />
      ) : null}
      {refreshFailed ? (
        <Notice
          tone="warning"
          title={t["com.myoxus.recurrence.unavailable"]()}
        />
      ) : null}
      <Group justify="flex-end">
        <Button disabled={pending} onClick={onClose}>
          {readonly ? t["com.myoxus.peek-view-controls.close"]() : t.Cancel()}
        </Button>
        {!readonly ? (
          <Button
            variant="primary"
            disabled={
              pending ||
              !previewReady ||
              !recipe.title.trim() ||
              !recipe.databaseId ||
              Boolean(destinations.destinationError)
            }
            onClick={() => void save()}
          >
            {t.Save()}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
