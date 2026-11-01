// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  databaseFieldDisplayName,
  databaseOptionDisplayName,
} from "../presentation/task-labels";

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { MemberSelectorInline } from "@myoxus/core/components/member-selector";
import {
  TagItem,
  WorkspaceTagsInlineEditor,
} from "@myoxus/core/components/tags";
import { isWorkspaceTagColorRole } from "@myoxus/core/modules/tag";
import { TagService } from "@myoxus/core/modules/tag/service/tag";
import {
  clearDatabaseCellValueMutation,
  DatabaseFieldKind,
  DatabaseFormulaStaleState,
  DatabaseRollupStaleState,
  updateDatabaseCellValueMutation,
  updateDatabaseRowTitleMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { LinkIcon, OpenInNewIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  Checkbox,
  Group,
  InlineEdit,
  type InlineEditHandle,
  Input,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  type MenuRef,
  MultiSelect,
  MyoxusText,
  NumberInput,
  OrdinalSlider,
  ProgressSlider,
  Select,
  Stack,
  type TagColorRole,
} from "@myoxus/ui-facade";
import {
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { DatabaseDocumentPicker } from "../document-picker";
import { managedTaskFields } from "../managed";
import { DATABASE_CURRENCY_OPTIONS, type I18nShape } from "../field-settings";
import {
  createCellValueInput,
  formatCellValue,
  getCellPrimitiveValue,
  getCellValue,
  getDatabaseCellEditRevision,
  getSelectOptions,
  isDatabaseProjectionField,
  normalizeDatabaseCurrencyCellValue,
  normalizeDatabaseDurationCellValue,
} from "../model";
import { useDatabaseConflictController } from "../presence";
import type { TaskDetailEditSession } from "../row-detail/task-navigation";
import { executeRevisionMutation } from "../presence/execute-revision-mutation";
import {
  DatabaseRelationCellEditor,
  DatabaseTaskParentCellEditor,
  DatabaseTaskBlockedByCellEditor,
} from "../relation";
import {
  resolveTaskParentProperty,
  resolveTaskBlockedByProperty,
} from "../row-detail/field-role-resolver";
import type {
  ParentCapability,
  TaskRelationEditLifetime,
} from "../relation/relation-cell-editor";
import type { BlockedByProjection } from "../relation/task-blocked-by-editor";
import {
  type DatabaseChangeHandler,
  databaseWallTimeToInstant,
  databaseZonedDate,
  databaseZonedDateTime,
} from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";
import { DatabaseFilesCell } from "./files-cell";
import { TaskDueInput, type TaskDueDraft } from "./task-due-input";
import { scheduleWallTimeToInstant } from "../shared/schedule-values";
import { DatabaseReminderControl } from "./reminder-control";
import {
  DatabaseRichTextCell,
  type DatabaseRichTextCellHandle,
} from "./rich-text-cell";

type DatabaseDateTimeCellValue = {
  allDay: boolean;
  end: string | null;
  start: string;
  timeZone: string;
};

export function updateDatabaseDateTimeWallTime(
  value: DatabaseDateTimeCellValue | null | undefined,
  wallTime: string,
  timeZone: string,
): DatabaseDateTimeCellValue | null {
  const start = databaseWallTimeToInstant(wallTime, timeZone);
  if (!start) return null;

  const previousStart = value?.start ? new Date(value.start).getTime() : null;
  const previousEnd = value?.end ? new Date(value.end).getTime() : null;
  const end =
    previousStart !== null &&
    previousEnd !== null &&
    Number.isFinite(previousStart) &&
    Number.isFinite(previousEnd)
      ? new Date(
          new Date(start).getTime() + (previousEnd - previousStart),
        ).toISOString()
      : null;

  return {
    allDay: Boolean(value?.allDay),
    end,
    start,
    timeZone,
  };
}

export function databaseFormulaStatusLabel(
  t: I18nShape,
  state: DatabaseFormulaStaleState,
) {
  switch (state) {
    case DatabaseFormulaStaleState.Current:
      return t["com.myoxus.database.formula.status.current"]();
    case DatabaseFormulaStaleState.Failed:
      return t["com.myoxus.database.formula.status.failed"]();
    case DatabaseFormulaStaleState.Queued:
      return t["com.myoxus.database.formula.status.queued"]();
    case DatabaseFormulaStaleState.RecomputePending:
      return t["com.myoxus.database.formula.status.recompute-pending"]();
    case DatabaseFormulaStaleState.Stale:
      return t["com.myoxus.database.formula.status.stale"]();
    default:
      return state;
  }
}

export function databaseFormulaStatusTone(state: DatabaseFormulaStaleState) {
  switch (state) {
    case DatabaseFormulaStaleState.Current:
      return "success" as const;
    case DatabaseFormulaStaleState.Failed:
      return "error" as const;
    case DatabaseFormulaStaleState.Queued:
      return "info" as const;
    case DatabaseFormulaStaleState.RecomputePending:
    case DatabaseFormulaStaleState.Stale:
      return "warning" as const;
    default:
      return "neutral" as const;
  }
}

export function databaseRollupStatusLabel(
  t: I18nShape,
  state: DatabaseRollupStaleState,
) {
  switch (state) {
    case DatabaseRollupStaleState.Current:
      return t["com.myoxus.database.rollup.status.current"]();
    case DatabaseRollupStaleState.Failed:
      return t["com.myoxus.database.rollup.status.failed"]();
    case DatabaseRollupStaleState.Queued:
      return t["com.myoxus.database.rollup.status.queued"]();
    case DatabaseRollupStaleState.RecomputePending:
      return t["com.myoxus.database.rollup.status.recompute-pending"]();
    case DatabaseRollupStaleState.Stale:
      return t["com.myoxus.database.rollup.status.stale"]();
    default:
      return state;
  }
}

export function databaseRollupStatusTone(state: DatabaseRollupStaleState) {
  switch (state) {
    case DatabaseRollupStaleState.Current:
      return "success" as const;
    case DatabaseRollupStaleState.Failed:
      return "error" as const;
    case DatabaseRollupStaleState.Queued:
      return "info" as const;
    case DatabaseRollupStaleState.RecomputePending:
    case DatabaseRollupStaleState.Stale:
      return "warning" as const;
    default:
      return "neutral" as const;
  }
}

export function isClearedCellValue(
  field: DatabaseField,
  value: unknown,
): boolean {
  // The P3 server contract models an empty editable cell by deleting the
  // row/field value. Required Users instead retain an explicit empty list,
  // as allowed by their editable-default contract (including Task assignees).
  switch (field.fieldType) {
    case DatabaseFieldKind.Checkbox:
      return false;
    case DatabaseFieldKind.RichText: {
      if (value === null || value === undefined) return true;
      const document = createCellValueInput(field, value).richText?.document;
      if (
        !document ||
        typeof document !== "object" ||
        Array.isArray(document) ||
        document.type !== "doc" ||
        Object.keys(document).some((key) => key !== "type" && key !== "content")
      )
        return false;
      const content = "content" in document ? document.content : [];
      if (!Array.isArray(content) || content.length > 1) return false;
      if (!content.length) return true;
      const paragraph = content[0];
      // Native plain text joins paragraphs and preserves whitespace/breaks.
      // Only the canonical empty paragraph has no content to retain.
      return Boolean(
        paragraph &&
        typeof paragraph === "object" &&
        !Array.isArray(paragraph) &&
        paragraph.type === "paragraph" &&
        Object.keys(paragraph).every(
          (key) => key === "type" || key === "content",
        ) &&
        (paragraph.content === undefined ||
          (Array.isArray(paragraph.content) && !paragraph.content.length)),
      );
    }
    case DatabaseFieldKind.Date:
    case DatabaseFieldKind.DateTime:
    case DatabaseFieldKind.Files:
    case DatabaseFieldKind.Select:
    case DatabaseFieldKind.Status:
    case DatabaseFieldKind.User:
      return value === null || value === undefined || value === "";
    case DatabaseFieldKind.Url:
    case DatabaseFieldKind.Email:
    case DatabaseFieldKind.Phone:
      return String(value ?? "").trim() === "";
    case DatabaseFieldKind.MultiSelect:
    case DatabaseFieldKind.Tags:
    case DatabaseFieldKind.Relation:
      return Array.isArray(value) && value.length === 0;
    case DatabaseFieldKind.Users:
      return !field.required && Array.isArray(value) && value.length === 0;
    case DatabaseFieldKind.Rollup:
    case DatabaseFieldKind.Formula:
    case DatabaseFieldKind.CreatedTime:
    case DatabaseFieldKind.CreatedBy:
    case DatabaseFieldKind.UpdatedTime:
    case DatabaseFieldKind.UpdatedBy:
      return false;
    case DatabaseFieldKind.Number:
    case DatabaseFieldKind.Percent:
      return value === null || value === undefined || value === "";
    case DatabaseFieldKind.Currency:
      return (
        value === null ||
        value === undefined ||
        value === "" ||
        normalizeDatabaseCurrencyCellValue(value, field) === null
      );
    case DatabaseFieldKind.Duration:
      return (
        value === null ||
        value === undefined ||
        value === "" ||
        normalizeDatabaseDurationCellValue(value) === null
      );
    case DatabaseFieldKind.Text:
      return String(value ?? "") === "";
    default:
      return false;
  }
}

export function phoneActionHref(value: string) {
  const compact = value.trim().replace(/[\s().\-/]/g, "");
  return /^\+?\d{8,15}$/.test(compact) ? `tel:${compact}` : null;
}

export function cellActionHref(field: DatabaseField, value: string) {
  if (!value) return null;
  switch (field.fieldType) {
    case DatabaseFieldKind.Url:
      return value;
    case DatabaseFieldKind.Email:
      return `mailto:${value}`;
    case DatabaseFieldKind.Phone:
      return phoneActionHref(value);
    default:
      return null;
  }
}

export function DatabaseLinkedStringCell({
  field,
  primitiveValue,
  saveValue,
}: {
  field: DatabaseField;
  primitiveValue: unknown;
  saveValue: (value: unknown) => Promise<void>;
}) {
  const t = useI18n();
  const value = typeof primitiveValue === "string" ? primitiveValue : "";
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const actionHref = cellActionHref(field, value);

  useEffect(() => {
    setDraft(value);
    setError("");
  }, [value]);

  const commit = useCallback(async () => {
    if (draft === value) return;
    setError("");
    try {
      await saveValue(draft);
    } catch (mutationError) {
      const message =
        mutationError instanceof Error
          ? mutationError.message
          : t["com.myoxus.database.cell.validation-failed"]();
      setError(message);
    }
  }, [draft, saveValue, t, value]);

  return (
    <Stack gap="xs">
      <Input
        value={draft}
        onChange={setDraft}
        onEnter={() => void commit()}
        onBlur={() => void commit()}
        status={error ? "error" : "default"}
        aria-label={field.name}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        block
        endFix={
          actionHref ? (
            <MyoxusText
              component="a"
              href={actionHref}
              rel={
                field.fieldType === DatabaseFieldKind.Url
                  ? "noopener noreferrer"
                  : undefined
              }
              target={
                field.fieldType === DatabaseFieldKind.Url ? "_blank" : undefined
              }
              tone="link"
              typographySlot="caption"
              aria-label={t["com.myoxus.database.cell.open-action"]()}
            >
              <OpenInNewIcon />
            </MyoxusText>
          ) : null
        }
        data-testid="database-cell-linked-text-input"
      />
      {error ? (
        <MyoxusText
          tone="danger"
          typographySlot="body-small"
          data-testid="database-cell-validation-error"
        >
          {error}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}

export function DatabaseProjectionCell({
  field,
  row,
}: {
  field: DatabaseField;
  row: DatabaseRowRecord;
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const value = formatCellValue(
    row,
    field,
    t.language,
    undefined,
    regionalPreferences,
  );
  return (
    <Group gap="xs" wrap="wrap" data-testid="database-projection-cell">
      <MyoxusText tone={value ? "primary" : "secondary"}>
        {value || t["com.myoxus.database.cell.empty"]()}
      </MyoxusText>
      <Badge tone="neutral">{t["com.myoxus.database.cell.projection"]()}</Badge>
    </Group>
  );
}

export function DatabaseRollupCell({
  field,
  row,
}: {
  field: DatabaseField;
  row: DatabaseRowRecord;
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const rollup = getCellValue(row, field.id)?.value.rollup;
  const status =
    rollup?.staleState ?? DatabaseRollupStaleState.RecomputePending;
  const value = formatCellValue(
    row,
    field,
    t.language,
    {
      checkboxTrue: t["com.myoxus.database.rollup.boolean.true"](),
    },
    regionalPreferences,
  );
  return (
    <Stack gap="xs" data-testid="database-rollup-cell">
      <Group gap="xs" align="center" wrap="wrap">
        <MyoxusText tone={value ? "primary" : "secondary"}>
          {value || t["com.myoxus.database.cell.empty"]()}
        </MyoxusText>
        <Badge
          data-rollup-state={status}
          data-testid="database-rollup-status"
          tone={databaseRollupStatusTone(status)}
        >
          {databaseRollupStatusLabel(t, status)}
        </Badge>
      </Group>
      {status === DatabaseRollupStaleState.Failed && rollup?.errorMessage ? (
        <MyoxusText tone="secondary" typographySlot="body-small">
          {rollup.errorMessage}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}

export function DatabaseFormulaCell({
  field,
  row,
}: {
  field: DatabaseField;
  row: DatabaseRowRecord;
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  const formula = getCellValue(row, field.id)?.value.formula;
  const status =
    formula?.staleState ?? DatabaseFormulaStaleState.RecomputePending;
  const value = formatCellValue(
    row,
    field,
    t.language,
    {
      checkboxTrue: t["com.myoxus.database.formula.boolean.true"](),
    },
    regionalPreferences,
  );
  return (
    <Stack gap="xs" data-testid="database-formula-cell">
      <Group gap="xs" align="center" wrap="wrap">
        <MyoxusText tone={value ? "primary" : "secondary"}>
          {value || t["com.myoxus.database.cell.empty"]()}
        </MyoxusText>
        <Badge
          data-formula-state={status}
          data-testid="database-formula-status"
          tone={databaseFormulaStatusTone(status)}
        >
          {databaseFormulaStatusLabel(t, status)}
        </Badge>
      </Group>
      {status === DatabaseFormulaStaleState.Failed && formula?.errorMessage ? (
        <MyoxusText tone="secondary" typographySlot="body-small">
          {formula.errorMessage}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}

export function stringArrayCellValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function databaseKanbanTagAccentRoles(
  tagIds: readonly string[],
  tags: ReadonlyArray<{ id: string; color: string }>,
): TagColorRole[] {
  return tagIds.flatMap((tagId) => {
    const color = tags.find((tag) => tag.id === tagId)?.color;
    return isWorkspaceTagColorRole(color) ? [color] : [];
  });
}

export function DatabaseTagBadges({ tagIds }: { tagIds: string[] }) {
  const t = useI18n();
  const tagService = useService(TagService);
  const tags = useLiveData(tagService.tagList.tagMetas$);
  if (!tagIds.length) return null;
  return (
    <Group wrap="wrap" data-testid="database-tag-badges">
      {tagIds.map((id) => {
        const tag = tags.find((candidate) => candidate.id === id);
        return tag ? (
          <TagItem key={id} tag={tag} mode="db-label" />
        ) : (
          <Badge key={id}>{t["com.myoxus.template-list.unavailable"]()}</Badge>
        );
      })}
    </Group>
  );
}

export function DatabaseTagsCellEditor({
  selected,
  commit,
}: {
  selected: string[];
  commit: (tagIds: string[]) => string[] | Promise<string[]>;
}) {
  const t = useI18n();
  return (
    <WorkspaceTagsInlineEditor
      block
      selectedTags={selected}
      commit={commit}
      tagMode="db-label"
      placeholder={t["com.myoxus.tags.assignment.add"]()}
    />
  );
}

export function DatabaseCellEditor({
  autoFocus = false,
  databaseId,
  field,
  record,
  row,
  rows,
  onChanged,
  expanded = false,
  inlineDisplayLineClamp,
  inlineEditTrigger = "doubleClick",
  inlineRichText = false,
  richTextHandleRef,
  onRichTextDraftStateChange,
  onInlineEditChange,
  onRequestInlineEdit,
  readonly = false,
  semanticRoleKey,
  onTaskParentCapability,
  onEditSessionChange,
  dueOpenRequest,
  onDueCancel,
  onTaskBlockedByProjection,
}: {
  autoFocus?: boolean;
  databaseId: string;
  field: DatabaseField;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  rows: DatabaseRowRecord[];
  onChanged: DatabaseChangeHandler;
  expanded?: boolean;
  inlineDisplayLineClamp?: number | false;
  inlineEditTrigger?: "click" | "doubleClick";
  inlineRichText?: boolean;
  richTextHandleRef?: Ref<DatabaseRichTextCellHandle>;
  onRichTextDraftStateChange?: (state: {
    dirty: boolean;
    pending: boolean;
  }) => void;
  onInlineEditChange?: (editing: boolean) => void;
  // The detail leave guard may defer activation; the Cell retains the live handle.
  onRequestInlineEdit?: (start: () => void) => void;
  readonly?: boolean;
  semanticRoleKey?: string;
  onTaskParentCapability?: (value: ParentCapability | null) => void;
  onEditSessionChange?: (session: TaskDetailEditSession | null) => void;
  dueOpenRequest?: number;
  onDueCancel?: () => void;
  onTaskBlockedByProjection?: (value: BlockedByProjection | null) => void;
}) {
  const t = useI18n();
  const fieldName = databaseFieldDisplayName(t, record, row, field);
  const isTaskDue = Boolean(
    field.fieldType === DatabaseFieldKind.DateTime &&
    row.row.rowKind === "task" &&
    row.row.databaseId === databaseId &&
    record.database.id === databaseId &&
    managedTaskFields(record)?.get("task.dueDate")?.id === field.id,
  );
  const hasTaskDueSession = isTaskDue && Boolean(onEditSessionChange);
  const optionLabel = (option: { id: string; name: string }) =>
    databaseOptionDisplayName(t, record, row, field, option);
  const parentProperty = resolveTaskParentProperty(record, row);
  const isTaskParent = Boolean(
    parentProperty &&
    parentProperty.field?.id === field.id &&
    !parentProperty.aliased,
  );
  const blockedByProperty = resolveTaskBlockedByProperty(record, row);
  const isTaskBlockedBy = Boolean(
    blockedByProperty &&
    blockedByProperty.field?.id === field.id &&
    !blockedByProperty.aliased,
  );
  const regionalPreferences = useRegionalPreferences();
  const conflicts = useDatabaseConflictController();
  const inlineEditRef = useRef<InlineEditHandle>(null);
  const richTextEditRef = useRef<DatabaseRichTextCellHandle>(null);
  const memberSelectorRef = useRef<MenuRef>(null);
  useEffect(() => {
    if (
      autoFocus &&
      !readonly &&
      (field.fieldType === DatabaseFieldKind.User ||
        field.fieldType === DatabaseFieldKind.Users)
    ) {
      memberSelectorRef.current?.changeOpen(true);
    }
  }, [autoFocus, readonly, field.fieldType]);
  useImperativeHandle(
    richTextHandleRef,
    () => ({
      discardDraft: () => richTextEditRef.current?.discardDraft(),
      finishEdit: () => richTextEditRef.current?.finishEdit(),
      saveDraft: () =>
        richTextEditRef.current?.saveDraft() ?? Promise.resolve(false),
    }),
    [],
  );
  const editBaselineRef = useRef<number | null>(null);
  // A confirmed write advances the next edit even if its later readback fails.
  // An already captured dirty baseline stays unchanged for conflict detection.
  const revisionOwnerKey = JSON.stringify([
    record.database.workspaceId,
    databaseId,
    row.row.id,
    field.id,
  ]);
  const revisionOwnerRef = useRef({ key: revisionOwnerKey, revision: 0 });
  if (revisionOwnerRef.current.key !== revisionOwnerKey) {
    revisionOwnerRef.current = { key: revisionOwnerKey, revision: 0 };
    editBaselineRef.current = null;
  }
  const revisionOwner = revisionOwnerRef.current;
  const previousRevisionOwner = useRef(revisionOwner);
  useEffect(() => {
    // Mounting a targeted editor is not an identity change. Discarding its
    // initial draft would also signal EditEnd and immediately close its owner.
    if (previousRevisionOwner.current === revisionOwner) return;
    previousRevisionOwner.current = revisionOwner;
    inlineEditRef.current?.discardDraft();
    richTextEditRef.current?.discardDraft();
  }, [revisionOwner]);
  const latestEditRevision = useCallback(
    () =>
      Math.max(
        revisionOwner.revision,
        field.fieldType === DatabaseFieldKind.Title
          ? row.row.editRevision
          : getDatabaseCellEditRevision(row, field.id),
      ),
    [revisionOwner, field.fieldType, field.id, row],
  );
  const confirmRevision = useCallback(
    (revision: number | undefined) => {
      // Object identity also fences an A→B→A selection from A's earlier write.
      if (revisionOwnerRef.current !== revisionOwner) return false;
      if (revision !== undefined)
        revisionOwner.revision = Math.max(revisionOwner.revision, revision);
      return true;
    },
    [revisionOwner],
  );
  const [dateTimeDraft, setDateTimeDraft] = useState<string | null>(null);
  const [taskDueDraft, setTaskDueDraft] = useState<TaskDueDraft | null>(null);
  const [dateTimeFailure, setDateTimeFailure] = useState<
    typeof revisionOwner | null
  >(null);
  const [dateTimePending, setDateTimePending] = useState<
    typeof revisionOwner | null
  >(null);
  const dateTimeEditRef = useRef<{
    owner: typeof revisionOwner;
    wallTime: string | null;
    allDay?: boolean;
    dirty: boolean;
    committing: boolean;
    committed: boolean;
    base?: Parameters<typeof updateDatabaseDateTimeWallTime>[0];
    timeZone?: string;
  } | null>(null);
  if (dateTimeEditRef.current?.owner !== revisionOwner) {
    dateTimeEditRef.current = {
      owner: revisionOwner,
      wallTime: null,
      dirty: false,
      committing: false,
      committed: false,
    };
  }
  const editAlive = useRef(true);
  const editAuthority = useRef({ isTaskDue, readonly });
  editAuthority.current = {
    isTaskDue,
    readonly: readonly || row.redacted || Boolean(row.row.deletedAt),
  };
  const dateTimeInstance = useId();
  const dateTimeScope = `database-due:${dateTimeInstance}:${revisionOwnerKey}`;
  const [duePopover, setDuePopover] = useState({
    owner: revisionOwner,
    request: dueOpenRequest,
    opened: dueOpenRequest !== undefined,
  });
  if (
    duePopover.owner !== revisionOwner ||
    duePopover.request !== dueOpenRequest
  ) {
    setDuePopover({
      owner: revisionOwner,
      request: dueOpenRequest,
      opened: dueOpenRequest !== undefined,
    });
  }
  const currentDateTimeOwner = useCallback(
    () =>
      editAlive.current &&
      revisionOwnerRef.current === revisionOwner &&
      dateTimeEditRef.current?.owner === revisionOwner,
    [revisionOwner],
  );
  const canWriteTaskDue = useCallback(
    () =>
      currentDateTimeOwner() &&
      editAuthority.current.isTaskDue &&
      !editAuthority.current.readonly,
    [currentDateTimeOwner],
  );
  useEffect(() => {
    editAlive.current = true;
    return () => {
      editAlive.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (isTaskDue) conflicts.dismiss?.(dateTimeScope);
    },
    [isTaskDue, conflicts, dateTimeScope],
  );
  const settleTaskDue = useCallback(
    (revision: number | undefined) => {
      const edit = dateTimeEditRef.current;
      if (
        revision === undefined ||
        !isTaskDue ||
        !currentDateTimeOwner() ||
        !edit
      )
        return;
      // Retire a native ACK before refresh can fail; Apply must not replay it.
      edit.committed = true;
      edit.dirty = false;
      editBaselineRef.current = null;
      setDateTimeDraft(null);
      setTaskDueDraft(null);
    },
    [isTaskDue, currentDateTimeOwner],
  );
  const tagEditRevisionRef = useRef(
    field.fieldType === DatabaseFieldKind.Tags
      ? getDatabaseCellEditRevision(row, field.id)
      : 0,
  );
  const [documentPickerOpen, setDocumentPickerOpen] = useState(false);
  const updateCell = useMutation(
    {
      mutation: updateDatabaseCellValueMutation,
    },
    {
      // RichText keeps invalid drafts mounted with a translated inline error.
      // Tag assignment has the same localized retry owner in its shared menu.
      // A second global transport toast would expose an internal server code.
      suppressErrorNotification:
        field.fieldType === DatabaseFieldKind.RichText ||
        field.fieldType === DatabaseFieldKind.Tags ||
        isTaskParent ||
        isTaskBlockedBy,
    },
  );
  const clearCell = useMutation(
    {
      mutation: clearDatabaseCellValueMutation,
    },
    {
      suppressErrorNotification:
        field.fieldType === DatabaseFieldKind.RichText ||
        field.fieldType === DatabaseFieldKind.Tags ||
        isTaskParent ||
        isTaskBlockedBy,
    },
  );
  const updateTitle = useMutation({
    mutation: updateDatabaseRowTitleMutation,
  });
  const primitiveValue = getCellPrimitiveValue(row, field);
  const [progressDraft, setProgressDraft] = useState(
    typeof primitiveValue === "number" ? primitiveValue : 0,
  );
  const selectOptions = getSelectOptions(field);
  const selectedOrdinalIndex = Math.max(
    0,
    selectOptions.findIndex(
      (option) => option.id === String(primitiveValue ?? ""),
    ),
  );
  const [ordinalDraft, setOrdinalDraft] = useState(selectedOrdinalIndex);
  useEffect(() => {
    setProgressDraft(typeof primitiveValue === "number" ? primitiveValue : 0);
  }, [primitiveValue]);
  useEffect(() => {
    setOrdinalDraft(selectedOrdinalIndex);
  }, [selectedOrdinalIndex]);
  useEffect(() => {
    if (field.fieldType === DatabaseFieldKind.Tags) {
      tagEditRevisionRef.current = getDatabaseCellEditRevision(row, field.id);
    }
  }, [field.fieldType, field.id, row]);
  const refreshValue = useCallback(
    () =>
      onChanged({
        kind:
          field.fieldType === DatabaseFieldKind.Title
            ? "row_updated"
            : "cell_updated",
        target: { fieldId: field.id, rowId: row.row.id },
      }),
    [field.fieldType, field.id, onChanged, row.row.id],
  );
  const reloadLatest = useCallback(async () => {
    inlineEditRef.current?.discardDraft();
    richTextEditRef.current?.discardDraft();
    editBaselineRef.current = null;
    dateTimeEditRef.current!.dirty = false;
    setDateTimeDraft(null);
    await onChanged();
  }, [onChanged]);
  const finishRichTextEdit = useCallback(() => {
    richTextEditRef.current?.finishEdit();
    editBaselineRef.current = null;
  }, []);

  const clearValue = useCallback(
    async (lifetime?: TaskRelationEditLifetime) => {
      if (
        field.fieldType === DatabaseFieldKind.Title ||
        field.fieldType === DatabaseFieldKind.Rollup ||
        field.fieldType === DatabaseFieldKind.Formula ||
        isDatabaseProjectionField(field.fieldType)
      )
        return;
      const result = await executeRevisionMutation(
        conflicts,
        async (variables: Parameters<typeof clearCell.trigger>[0]) => {
          if (lifetime && !lifetime.isCurrent())
            throw new Error("Task relation editor disposed");
          if (isTaskDue && !canWriteTaskDue())
            throw new Error("Task due editor disposed");
          try {
            return await clearCell.trigger(variables);
          } catch (error) {
            if (lifetime && !lifetime.isCurrent())
              throw new Error("Task relation editor disposed");
            lifetime?.onError(error);
            throw error;
          }
        },
        {
          databaseId,
          rowId: row.row.id,
          fieldId: field.id,
          expectedEditRevision: editBaselineRef.current ?? latestEditRevision(),
        },
        {
          scope: lifetime?.scope ?? (isTaskDue ? dateTimeScope : undefined),
          canOverwrite:
            lifetime?.isCurrent ?? (isTaskDue ? canWriteTaskDue : undefined),
          attemptedAction: fieldName,
          localValue: lifetime?.localValue ?? null,
          readServerValue: lifetime?.readServerValue,
          reloadLatest: () => {
            if (lifetime && !lifetime.isCurrent()) return;
            lifetime?.onDiscard();
            return reloadLatest();
          },
          afterSuccess: async (result) => {
            if (lifetime && !lifetime.isCurrent()) return;
            lifetime?.onCommitted();
            if (lifetime) editBaselineRef.current = null;
            if (!confirmRevision(result?.clearDatabaseCellValue?.editRevision))
              return;
            settleTaskDue(result?.clearDatabaseCellValue?.editRevision);
            await refreshValue();
          },
          afterForceSuccess: async (result) => {
            if (lifetime && !lifetime.isCurrent()) return;
            lifetime?.onCommitted();
            if (lifetime) editBaselineRef.current = null;
            if (!confirmRevision(result?.clearDatabaseCellValue?.editRevision))
              return;
            settleTaskDue(result?.clearDatabaseCellValue?.editRevision);
            finishRichTextEdit();
            await refreshValue();
          },
        },
      );
      return result !== undefined && revisionOwnerRef.current === revisionOwner;
    },
    [
      clearCell,
      isTaskDue,
      dateTimeScope,
      canWriteTaskDue,
      settleTaskDue,
      conflicts,
      databaseId,
      field,
      confirmRevision,
      latestEditRevision,
      revisionOwner,
      finishRichTextEdit,
      onChanged,
      refreshValue,
      reloadLatest,
      row,
    ],
  );

  const saveValue = useCallback(
    async (value: unknown, lifetime?: TaskRelationEditLifetime) => {
      if (
        field.fieldType === DatabaseFieldKind.Rollup ||
        field.fieldType === DatabaseFieldKind.Formula ||
        isDatabaseProjectionField(field.fieldType)
      )
        return;
      if (field.fieldType === DatabaseFieldKind.Title) {
        const title = String(value || t["Untitled"]());
        const result = await executeRevisionMutation(
          conflicts,
          updateTitle.trigger,
          {
            databaseId,
            rowId: row.row.id,
            title,
            titleFieldId: field.id,
            expectedEditRevision:
              editBaselineRef.current ?? latestEditRevision(),
          },
          {
            attemptedAction: fieldName,
            localValue: title,
            reloadLatest,
            afterSuccess: async (result) => {
              if (
                !confirmRevision(result?.updateDatabaseRowTitle?.editRevision)
              )
                return;
              await refreshValue();
            },
            afterForceSuccess: async (result) => {
              if (
                !confirmRevision(result?.updateDatabaseRowTitle?.editRevision)
              )
                return;
              finishRichTextEdit();
              await refreshValue();
            },
          },
        );
        return (
          result !== undefined && revisionOwnerRef.current === revisionOwner
        );
      } else {
        if (isClearedCellValue(field, value)) {
          return clearValue(lifetime);
        }
        const inputValue = createCellValueInput(field, value);
        const result = await executeRevisionMutation(
          conflicts,
          async (variables: Parameters<typeof updateCell.trigger>[0]) => {
            // Force reuses this same intent; never let an old dialog mutate as
            // a later actor, and retain typed graph failures in its own draft.
            if (lifetime && !lifetime.isCurrent())
              throw new Error("Task relation editor disposed");
            if (isTaskDue && !canWriteTaskDue())
              throw new Error("Task due editor disposed");
            try {
              return await updateCell.trigger(variables);
            } catch (error) {
              if (lifetime && !lifetime.isCurrent())
                throw new Error("Task relation editor disposed");
              lifetime?.onError(error);
              throw error;
            }
          },
          {
            databaseId,
            rowId: row.row.id,
            fieldId: field.id,
            value: inputValue,
            expectedEditRevision:
              editBaselineRef.current ?? latestEditRevision(),
          },
          {
            scope: lifetime?.scope ?? (isTaskDue ? dateTimeScope : undefined),
            canOverwrite:
              lifetime?.isCurrent ?? (isTaskDue ? canWriteTaskDue : undefined),
            attemptedAction: fieldName,
            localValue: lifetime?.localValue ?? value,
            readServerValue: lifetime?.readServerValue,
            reloadLatest: () => {
              if (lifetime && !lifetime.isCurrent()) return;
              lifetime?.onDiscard();
              return reloadLatest();
            },
            afterSuccess: async (result) => {
              if (lifetime && !lifetime.isCurrent()) return;
              lifetime?.onCommitted();
              if (lifetime) editBaselineRef.current = null;
              if (
                !confirmRevision(result?.updateDatabaseCellValue?.editRevision)
              )
                return;
              settleTaskDue(result?.updateDatabaseCellValue?.editRevision);
              await refreshValue();
            },
            afterForceSuccess: async (result) => {
              if (lifetime && !lifetime.isCurrent()) return;
              lifetime?.onCommitted();
              if (lifetime) editBaselineRef.current = null;
              if (
                !confirmRevision(result?.updateDatabaseCellValue?.editRevision)
              )
                return;
              settleTaskDue(result?.updateDatabaseCellValue?.editRevision);
              finishRichTextEdit();
              await refreshValue();
            },
          },
        );
        return (
          result !== undefined && revisionOwnerRef.current === revisionOwner
        );
      }
    },
    [
      clearValue,
      isTaskDue,
      dateTimeScope,
      canWriteTaskDue,
      settleTaskDue,
      conflicts,
      databaseId,
      field,
      confirmRevision,
      latestEditRevision,
      revisionOwner,
      finishRichTextEdit,
      onChanged,
      refreshValue,
      row,
      row.row.id,
      reloadLatest,
      t,
      updateCell,
      updateTitle,
    ],
  );
  const saveValueVoid = useCallback(
    async (value: unknown) => {
      await saveValue(value);
    },
    [saveValue],
  );
  const beginDeferredCellEdit = useCallback(() => {
    editBaselineRef.current ??= latestEditRevision();
  }, [latestEditRevision]);
  const commitDeferredCellEdit = useCallback(
    async (value: unknown) => {
      beginDeferredCellEdit();
      const saved = await saveValue(value);
      if (saved) editBaselineRef.current = null;
    },
    [beginDeferredCellEdit, saveValue],
  );
  const commitTagValue = useCallback(
    async (nextIds: string[]) => {
      if (field.fieldType !== DatabaseFieldKind.Tags) {
        return nextIds;
      }
      const expectedEditRevision = tagEditRevisionRef.current;
      if (nextIds.length === 0) {
        const response = await executeRevisionMutation(
          conflicts,
          clearCell.trigger,
          {
            databaseId,
            rowId: row.row.id,
            fieldId: field.id,
            expectedEditRevision,
          },
          {
            attemptedAction: fieldName,
            localValue: nextIds,
            reloadLatest,
            afterSuccess: refreshValue,
            afterForceSuccess: refreshValue,
          },
        );
        const confirmed = response?.clearDatabaseCellValue;
        if (!confirmed || confirmed.hasValue) {
          throw new Error("Database tag clear was not confirmed");
        }
        tagEditRevisionRef.current = confirmed.editRevision;
        return [];
      }
      const response = await executeRevisionMutation(
        conflicts,
        updateCell.trigger,
        {
          databaseId,
          rowId: row.row.id,
          fieldId: field.id,
          value: createCellValueInput(field, nextIds),
          expectedEditRevision,
        },
        {
          attemptedAction: fieldName,
          localValue: nextIds,
          reloadLatest,
          afterSuccess: refreshValue,
          afterForceSuccess: refreshValue,
        },
      );
      const confirmed = response?.updateDatabaseCellValue;
      if (!confirmed?.value.tags) {
        throw new Error("Database tag assignment was not confirmed");
      }
      tagEditRevisionRef.current = confirmed.editRevision;
      return confirmed.value.tags;
    },
    [
      clearCell.trigger,
      conflicts,
      databaseId,
      field,
      onChanged,
      refreshValue,
      reloadLatest,
      row.row.id,
      updateCell.trigger,
    ],
  );

  const dateTimeValue = getCellValue(row, field.id)?.value.dateTime;
  const dateTimeZone =
    dateTimeValue?.timeZone ||
    field.config.dateTime?.defaultTimeZone ||
    (isTaskDue ? regionalPreferences.timezone : "UTC");
  const discardDateTime = useCallback(() => {
    const edit = dateTimeEditRef.current;
    if (!currentDateTimeOwner() || !edit || edit.committing) return;
    if (isTaskDue) conflicts.dismiss?.(dateTimeScope);
    edit.dirty = false;
    edit.wallTime = null;
    edit.allDay = undefined;
    edit.base = undefined;
    edit.timeZone = undefined;
    editBaselineRef.current = null;
    setDateTimeDraft(null);
    setDateTimeFailure(null);
    setTaskDueDraft(null);
  }, [currentDateTimeOwner, isTaskDue, conflicts, dateTimeScope]);
  const cancelDateTime = () => {
    if (!currentDateTimeOwner() || dateTimeEditRef.current?.committing) return;
    discardDateTime();
    setDuePopover((current) => ({ ...current, opened: false }));
    onDueCancel?.();
  };
  // Native Confirm and navigation Apply share the same intent and ACK boundary.
  const commitDateTime = useCallback(async (): Promise<boolean> => {
    const edit = dateTimeEditRef.current;
    if (
      !currentDateTimeOwner() ||
      readonly ||
      (isTaskDue && !canWriteTaskDue()) ||
      !edit?.dirty ||
      (!isTaskDue && !edit.wallTime) ||
      edit.committing
    )
      return false;
    const zone = edit.timeZone ?? dateTimeZone;
    if (
      isTaskDue &&
      edit.wallTime &&
      !scheduleWallTimeToInstant(edit.wallTime, zone)
    )
      return false;
    const nextValue = edit.wallTime
      ? updateDatabaseDateTimeWallTime(edit.base, edit.wallTime, zone)
      : null;
    if (!nextValue && (!isTaskDue || edit.wallTime)) return false;
    const value =
      isTaskDue && nextValue
        ? { ...nextValue, allDay: edit.allDay ?? true }
        : nextValue;
    edit.committing = true;
    edit.committed = false;
    setDateTimePending(revisionOwner);
    try {
      const saved = await saveValue(value);
      // A confirmed save can close/unmount this editor during its refresh.
      if (edit.committed) return true;
      if (!currentDateTimeOwner()) return false;
      if (saved && (!isTaskDue || edit.committed)) {
        edit.dirty = false;
        editBaselineRef.current = null;
        setDateTimeDraft(null);
      }
      return isTaskDue ? edit.committed : saved === true;
    } catch {
      if (currentDateTimeOwner() && !edit.committed)
        setDateTimeFailure(revisionOwner);
      return edit.committed;
    } finally {
      edit.committing = false;
      if (currentDateTimeOwner()) setDateTimePending(null);
    }
  }, [
    currentDateTimeOwner,
    readonly,
    isTaskDue,
    canWriteTaskDue,
    dateTimeZone,
    revisionOwner,
    saveValue,
  ]);
  const dateTimeSession = useRef({ commitDateTime, discardDateTime });
  dateTimeSession.current = { commitDateTime, discardDateTime };
  const dateTimeEdit = dateTimeEditRef.current!;
  useEffect(() => {
    if (!hasTaskDueSession) return;
    if (row.redacted) {
      onEditSessionChange?.(null);
      return;
    }
    onEditSessionChange?.({
      dirty: dateTimeEdit.dirty,
      pending: dateTimeEdit.committing,
      apply: () =>
        currentDateTimeOwner()
          ? dateTimeSession.current.commitDateTime()
          : Promise.resolve(false),
      discard: () => {
        if (currentDateTimeOwner()) dateTimeSession.current.discardDateTime();
      },
    });
  }, [
    hasTaskDueSession,
    row.redacted,
    dateTimeDraft,
    taskDueDraft,
    dateTimePending,
    dateTimeEdit,
    currentDateTimeOwner,
    onEditSessionChange,
  ]);
  useEffect(
    () => () => {
      if (hasTaskDueSession) onEditSessionChange?.(null);
    },
    [hasTaskDueSession, revisionOwner, onEditSessionChange],
  );

  const requestInlineEdit = (event: {
    target: EventTarget | null;
    preventDefault: () => void;
    stopPropagation: () => void;
  }) => {
    if (!onRequestInlineEdit || readonly) return;
    const display =
      event.target instanceof Element
        ? event.target.closest(
            'button[data-myoxus-ui-role="inline-edit-display"]',
          )
        : null;
    if (!display) return;
    event.preventDefault();
    event.stopPropagation();
    onRequestInlineEdit(() => {
      if (
        editAlive.current &&
        revisionOwnerRef.current === revisionOwner &&
        !editAuthority.current.readonly
      )
        inlineEditRef.current?.triggerEdit();
    });
  };

  if (row.redacted) {
    return (
      <MyoxusText tone="secondary">
        {t["com.myoxus.database.row.redacted"]()}
      </MyoxusText>
    );
  }

  if (isTaskParent) {
    return (
      <DatabaseTaskParentCellEditor
        field={field}
        record={record}
        row={row}
        onCapability={onTaskParentCapability}
        onEditSessionChange={onEditSessionChange}
        value={stringArrayCellValue(primitiveValue)}
        readonly={readonly}
        onChange={(next, lifetime) => {
          editBaselineRef.current ??= latestEditRevision();
          return saveValue(next, lifetime);
        }}
      />
    );
  }

  if (isTaskBlockedBy) {
    return (
      <DatabaseTaskBlockedByCellEditor
        field={field}
        record={record}
        row={row}
        onProjection={onTaskBlockedByProjection}
        onEditSessionChange={onEditSessionChange}
        value={stringArrayCellValue(primitiveValue)}
        readonly={readonly}
        onChange={(next, lifetime) => {
          editBaselineRef.current ??= latestEditRevision();
          return saveValue(next, lifetime);
        }}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Rollup) {
    return <DatabaseRollupCell field={field} row={row} />;
  }

  if (field.fieldType === DatabaseFieldKind.Formula) {
    return <DatabaseFormulaCell field={field} row={row} />;
  }

  if (isDatabaseProjectionField(field.fieldType)) {
    return <DatabaseProjectionCell field={field} row={row} />;
  }

  if (
    field.fieldType === DatabaseFieldKind.Title ||
    field.fieldType === DatabaseFieldKind.Text
  ) {
    return (
      <InlineEdit
        editable={!readonly}
        displayLineClamp={inlineDisplayLineClamp}
        handleRef={inlineEditRef}
        inputAttrs={{ "aria-label": fieldName }}
        onClickCapture={requestInlineEdit}
        onKeyDownCapture={(event) => {
          if (event.key === "F2") requestInlineEdit(event);
        }}
        onEditStart={() => {
          onInlineEditChange?.(true);
          editBaselineRef.current = latestEditRevision();
        }}
        onEditEnd={(outcome) => {
          if (outcome === "cancel") editBaselineRef.current = null;
          onInlineEditChange?.(false);
        }}
        trigger={inlineEditTrigger}
        value={String(primitiveValue ?? "")}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        onChange={(value) => {
          if (value !== primitiveValue) {
            void saveValue(value).then((saved) => {
              if (saved) editBaselineRef.current = null;
            });
          } else {
            editBaselineRef.current = null;
          }
        }}
        data-testid="database-cell-inline-edit"
      />
    );
  }

  if (
    field.fieldType === DatabaseFieldKind.Url ||
    field.fieldType === DatabaseFieldKind.Email ||
    field.fieldType === DatabaseFieldKind.Phone
  ) {
    return (
      <DatabaseLinkedStringCell
        field={field}
        primitiveValue={primitiveValue}
        saveValue={saveValueVoid}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Date) {
    const dateValue =
      typeof primitiveValue === "string" && primitiveValue
        ? primitiveValue
        : null;
    return (
      <LocalizedDateInput
        value={dateValue}
        locale={t.language}
        aria-label={fieldName}
        allowDeselect
        clearable
        valueFormat={expanded ? undefined : "L"}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        onChange={(value) => {
          if (typeof value === "string" && value) void saveValue(value);
          else void clearValue();
        }}
        data-testid="database-cell-date-input"
        data-myoxus-ui-role="database-date-cell"
      />
    );
  }

  if (isTaskDue) {
    const invalidDate = Boolean(
      dateTimeEdit.dirty &&
      dateTimeEdit.wallTime &&
      !scheduleWallTimeToInstant(
        dateTimeEdit.wallTime,
        dateTimeEdit.timeZone ?? dateTimeZone,
      ),
    );
    const current: TaskDueDraft = {
      wallTime: dateTimeValue?.start
        ? dateTimeValue.allDay
          ? `${databaseZonedDate(dateTimeValue.start, dateTimeZone)} 00:00:00`
          : databaseZonedDateTime(dateTimeValue.start, dateTimeZone)
        : null,
      allDay: dateTimeValue?.allDay ?? true,
    };
    return (
      <Stack>
        <TaskDueInput
          value={dateTimeEdit.dirty && taskDueDraft ? taskDueDraft : current}
          timeZone={
            dateTimeEdit.dirty
              ? (dateTimeEdit.timeZone ?? dateTimeZone)
              : dateTimeZone
          }
          label={fieldName}
          disabled={dateTimeEdit.committing}
          readOnly={readonly}
          error={
            invalidDate
              ? t["com.myoxus.database.tasks.invalid-date"]()
              : dateTimeFailure === revisionOwner
                ? t["com.myoxus.common.operation-failed"]()
                : undefined
          }
          inputId={dateTimeInstance}
          fieldId={field.id}
          popoverProps={
            dueOpenRequest !== undefined
              ? {
                  opened:
                    duePopover.owner === revisionOwner &&
                    duePopover.opened &&
                    canWriteTaskDue() &&
                    !dateTimeEdit.committing,
                  onOpen: () => {
                    if (canWriteTaskDue() && !dateTimeEdit.committing)
                      setDuePopover((current) =>
                        current.owner === revisionOwner &&
                        current.request === dueOpenRequest
                          ? { ...current, opened: true }
                          : current,
                      );
                  },
                  onClose: () => {
                    if (currentDateTimeOwner())
                      setDuePopover((current) =>
                        current.owner === revisionOwner &&
                        current.request === dueOpenRequest
                          ? { ...current, opened: false }
                          : current,
                      );
                  },
                }
              : undefined
          }
          onChange={(next) => {
            if (!canWriteTaskDue() || dateTimeEdit.committing) return;
            if (!dateTimeEdit.dirty) {
              editBaselineRef.current ??= latestEditRevision();
              dateTimeEdit.base = dateTimeValue;
              dateTimeEdit.timeZone = dateTimeZone;
            }
            dateTimeEdit.wallTime = next.wallTime;
            dateTimeEdit.allDay = next.allDay;
            dateTimeEdit.dirty = true;
            setDateTimeFailure(null);
            setTaskDueDraft(next);
          }}
          onConfirm={() => void commitDateTime()}
          onCancel={cancelDateTime}
        />
        {!readonly && dateTimeEdit.dirty ? (
          <Group>
            <Button
              type="button"
              disabled={dateTimeEdit.committing}
              onClick={cancelDateTime}
            >
              {t.Cancel()}
            </Button>
            <Button
              type="button"
              disabled={dateTimeEdit.committing || invalidDate}
              onClick={() => void commitDateTime()}
            >
              {t.Confirm()}
            </Button>
          </Group>
        ) : null}
        <DatabaseReminderControl field={field} record={record} row={row} />
      </Stack>
    );
  }

  if (field.fieldType === DatabaseFieldKind.DateTime) {
    const timeZone = dateTimeZone;
    const updateDateTimeStart = (wallTime: string) => {
      if (readonly) return;
      const nextValue = updateDatabaseDateTimeWallTime(
        dateTimeValue,
        wallTime,
        timeZone,
      );
      if (nextValue) void saveValue(nextValue);
    };
    return (
      <Group align="center" wrap="nowrap">
        {dateTimeValue?.allDay ? (
          <LocalizedDateInput
            value={
              dateTimeValue.start
                ? databaseZonedDate(dateTimeValue.start, timeZone)
                : null
            }
            locale={t.language}
            aria-label={fieldName}
            allowDeselect={!readonly}
            readOnly={readonly}
            clearable={!readonly}
            valueFormat={expanded ? undefined : "L"}
            placeholder={t["com.myoxus.database.cell.empty"]()}
            onChange={(value) => {
              if (readonly) return;
              if (typeof value === "string" && value) {
                updateDateTimeStart(`${value} 00:00:00`);
              } else {
                void clearValue();
              }
            }}
            data-database-field-id={field.id}
            data-testid="database-cell-datetime-input"
            data-myoxus-ui-role="database-datetime-cell"
          />
        ) : (
          <LocalizedDateTimeInput
            error={
              dateTimeFailure === revisionOwner
                ? t["com.myoxus.common.operation-failed"]()
                : undefined
            }
            value={
              dateTimeEdit.dirty
                ? dateTimeDraft
                : dateTimeValue?.start
                  ? databaseZonedDateTime(dateTimeValue.start, timeZone)
                  : null
            }
            locale={t.language}
            aria-label={fieldName}
            readOnly={readonly}
            clearable={!readonly}
            valueFormat={expanded ? undefined : "L HH:mm"}
            placeholder={t["com.myoxus.database.cell.empty"]()}
            onChange={(value) => {
              if (readonly) return;
              if (typeof value === "string" && value) {
                if (!dateTimeEdit.dirty && editBaselineRef.current === null) {
                  editBaselineRef.current = latestEditRevision();
                  dateTimeEdit.base = dateTimeValue;
                  dateTimeEdit.timeZone = timeZone;
                }
                setDateTimeFailure(null);
                dateTimeEdit.wallTime = value;
                dateTimeEdit.dirty = true;
                setDateTimeDraft(value);
              } else {
                dateTimeEdit.dirty = false;
                setDateTimeDraft(null);
                void clearValue();
              }
            }}
            submitButtonProps={{ onClick: () => void commitDateTime() }}
            timePickerProps={{
              onKeyDownCapture: (event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitDateTime();
                }
              },
            }}
            onDropdownClose={() => {
              if (dateTimeEdit.committing) return;
              dateTimeEdit.dirty = false;
              setDateTimeDraft(null);
              editBaselineRef.current = null;
            }}
            data-database-field-id={field.id}
            data-testid="database-cell-datetime-input"
            data-myoxus-ui-role="database-datetime-cell"
          />
        )}
        <DatabaseReminderControl field={field} record={record} row={row} />
      </Group>
    );
  }

  if (field.fieldType === DatabaseFieldKind.Files) {
    return (
      <DatabaseFilesCell
        field={field}
        files={Array.isArray(primitiveValue) ? primitiveValue : []}
        workspaceId={record.database.workspaceId}
        onChange={saveValueVoid}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.RichText) {
    const richTextValue =
      typeof primitiveValue === "object" && primitiveValue !== null
        ? primitiveValue
        : null;
    return (
      <DatabaseRichTextCell
        autoFocus={autoFocus}
        expanded={expanded}
        inline={inlineRichText}
        fieldName={fieldName}
        value={richTextValue}
        handleRef={richTextEditRef}
        onDraftStateChange={onRichTextDraftStateChange}
        onEditEnd={() => {
          editBaselineRef.current = null;
          onInlineEditChange?.(false);
        }}
        onEditStart={() => {
          onInlineEditChange?.(true);
          editBaselineRef.current ??= latestEditRevision();
        }}
        onSave={saveValue}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.User) {
    const selectedUserId =
      typeof primitiveValue === "string" && primitiveValue
        ? primitiveValue
        : null;
    return (
      <MemberSelectorInline
        ref={memberSelectorRef}
        selected={selectedUserId ? [selectedUserId] : []}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        onChange={(selected) => {
          const nextUserId = selected.at(-1);
          if (nextUserId && nextUserId !== selectedUserId) {
            void saveValue(nextUserId);
          } else if (!nextUserId && selectedUserId) {
            void clearValue();
          }
        }}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Users) {
    return (
      <MemberSelectorInline
        ref={memberSelectorRef}
        selected={stringArrayCellValue(primitiveValue)}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        onChange={(selected) => {
          if (selected.length || field.required) {
            void saveValue(selected);
          } else {
            void clearValue();
          }
        }}
      />
    );
  }

  if (
    field.fieldType === DatabaseFieldKind.Number ||
    field.fieldType === DatabaseFieldKind.Percent ||
    field.fieldType === DatabaseFieldKind.Currency ||
    field.fieldType === DatabaseFieldKind.Duration
  ) {
    if (
      field.fieldType === DatabaseFieldKind.Percent &&
      semanticRoleKey === "task.progress"
    ) {
      return (
        <ProgressSlider
          ariaLabel={fieldName}
          readonly={readonly}
          value={progressDraft}
          onChange={(value) => {
            beginDeferredCellEdit();
            setProgressDraft(value);
          }}
          onChangeEnd={(value) => void commitDeferredCellEdit(value)}
        />
      );
    }
    if (field.fieldType === DatabaseFieldKind.Currency) {
      const currencyValue = normalizeDatabaseCurrencyCellValue(
        primitiveValue,
        field,
      );
      const currencyCode =
        currencyValue?.currencyCode ??
        field.config.currency?.defaultCurrency ??
        "EUR";
      const amountInput = (
        <NumberInput
          value={currencyValue?.amount}
          onChange={(amount) => void saveValue({ amount, currencyCode })}
          min={field.config.currency?.minValue ?? undefined}
          max={field.config.currency?.maxValue ?? undefined}
          suffix={
            field.config.currency?.allowCurrencyOverride
              ? undefined
              : ` ${currencyCode}`
          }
          aria-label={fieldName}
        />
      );

      if (!field.config.currency?.allowCurrencyOverride) {
        return amountInput;
      }

      return (
        <Group gap="xs" wrap="nowrap">
          {amountInput}
          <Select
            data={DATABASE_CURRENCY_OPTIONS.map((currency) => ({
              value: currency,
              label: currency,
            }))}
            value={currencyCode}
            onChange={(nextCurrency) =>
              void saveValue({
                amount: currencyValue?.amount ?? 0,
                currencyCode: nextCurrency ?? currencyCode,
              })
            }
            aria-label={t["com.myoxus.database.field.currency-code"]()}
          />
        </Group>
      );
    }

    if (field.fieldType === DatabaseFieldKind.Duration) {
      const durationValue = normalizeDatabaseDurationCellValue(primitiveValue);
      return (
        <NumberInput
          value={durationValue?.minutes}
          onChange={(minutes) => void saveValue({ minutes })}
          min={field.config.duration?.minMinutes ?? undefined}
          max={field.config.duration?.maxMinutes ?? undefined}
          suffix=" min"
          aria-label={fieldName}
        />
      );
    }

    return (
      <NumberInput
        value={typeof primitiveValue === "number" ? primitiveValue : undefined}
        onChange={(value) => void saveValue(value)}
        min={field.config.percent?.minValue ?? undefined}
        max={field.config.percent?.maxValue ?? undefined}
        suffix={field.fieldType === DatabaseFieldKind.Percent ? "%" : undefined}
        aria-label={fieldName}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Checkbox) {
    return (
      <Checkbox
        checked={Boolean(primitiveValue)}
        onChange={(_, checked) => void saveValue(checked)}
        aria-label={fieldName}
      />
    );
  }

  if (
    field.fieldType === DatabaseFieldKind.Select ||
    field.fieldType === DatabaseFieldKind.Status
  ) {
    if (
      field.fieldType === DatabaseFieldKind.Select &&
      (semanticRoleKey === "task.priority" ||
        semanticRoleKey === "task.complexity") &&
      selectOptions.length > 1
    ) {
      if (readonly && !primitiveValue) {
        return (
          <MyoxusText tone="secondary">
            {t["com.myoxus.database.cell.empty"]()}
          </MyoxusText>
        );
      }
      return (
        <Stack>
          {!primitiveValue ? (
            <MyoxusText tone="secondary">
              {t["com.myoxus.database.cell.empty"]()}
            </MyoxusText>
          ) : null}
          <OrdinalSlider
            ariaLabel={fieldName}
            options={selectOptions.map((option, index) => ({
              label: optionLabel(option),
              value: index,
            }))}
            readonly={readonly}
            value={ordinalDraft}
            onChange={(value) => {
              beginDeferredCellEdit();
              setOrdinalDraft(value);
            }}
            onChangeEnd={(index) => {
              const option = selectOptions[index];
              if (option) void commitDeferredCellEdit(option.id);
            }}
          />
        </Stack>
      );
    }
    return (
      <Select
        aria-label={fieldName}
        data={getSelectOptions(field).map((option) => ({
          value: option.id,
          label: optionLabel(option),
        }))}
        value={String(primitiveValue ?? "")}
        onChange={(value) => void saveValue(value)}
        onClear={() => void clearValue()}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        clearable
        block
        disabled={readonly}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.MultiSelect) {
    return (
      <MultiSelect
        data={getSelectOptions(field).map((option) => ({
          value: option.id,
          label: optionLabel(option),
        }))}
        value={stringArrayCellValue(primitiveValue)}
        onChange={(value) => void saveValue(value)}
        placeholder={t["com.myoxus.database.cell.empty"]()}
        clearable
        block
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.Tags) {
    return (
      <DatabaseTagsCellEditor
        selected={stringArrayCellValue(primitiveValue)}
        commit={commitTagValue}
      />
    );
  }

  if (field.fieldType === DatabaseFieldKind.DocumentLink) {
    const documentLink =
      getCellValue(row, field.id)?.value.documentLink ?? null;
    const target = documentLink?.target ?? null;
    const targetLabel =
      target?.state === "Available"
        ? target.title || t["com.myoxus.database.document_link.empty"]()
        : target?.state === "Redacted"
          ? t["com.myoxus.database.document_link.redacted"]()
          : documentLink
            ? t["com.myoxus.database.row_content.unavailable-title"]()
            : t["com.myoxus.database.document_link.empty"]();
    return (
      <>
        <Button
          variant="secondary"
          prefix={<LinkIcon />}
          onClick={() => setDocumentPickerOpen(true)}
          data-testid="database-document-link-editor"
        >
          {targetLabel}
        </Button>
        <DatabaseDocumentPicker
          open={documentPickerOpen}
          onOpenChange={setDocumentPickerOpen}
          workspaceId={record.database.workspaceId}
          currentDocumentId={documentLink?.docId ?? null}
          onSelect={(document) => saveValue({ docId: document.id })}
          onClear={documentLink ? () => clearValue() : undefined}
        />
      </>
    );
  }

  if (field.fieldType === DatabaseFieldKind.Relation) {
    return (
      <DatabaseRelationCellEditor
        field={field}
        value={stringArrayCellValue(primitiveValue)}
        onChange={(value) => void saveValue(value)}
        record={record}
        row={row}
        rows={rows}
      />
    );
  }

  // Future field kinds the active cell editor doesn't yet know how to render
  // fall back to a visible "Unsupported field" label so the user isn't misled
  // into editing or deleting data they can't see correctly.
  const supportedKinds = new Set<string>(Object.values(DatabaseFieldKind));
  if (!supportedKinds.has(field.fieldType)) {
    return (
      <MyoxusText tone="secondary">
        {t["com.myoxus.database.field.unsupported"]()}
      </MyoxusText>
    );
  }

  return (
    <MyoxusText tone="secondary">
      {formatCellValue(row, field, t.language, undefined, regionalPreferences)}
    </MyoxusText>
  );
}
