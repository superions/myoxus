// SPDX-License-Identifier: AGPL-3.0-or-later

import { GuardService } from "@myoxus/core/modules/permissions";
import { useLiveData, useService } from "@myoxus/infra";
import { useContextDocumentMenu } from "../assistance/context";
import { DocumentReviewTask } from "../assistance/document-review";
import { TaskRecurrenceControl } from "../../recurrence/task-recurrence";
import { InlineMemberList } from "@myoxus/core/components/member-selector/inline-member-list";
import { isWorkspaceTagColorRole } from "@myoxus/core/modules/tag";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import {
  AssistantContext,
  AssistantControlKind,
  AssistantGroupRole,
  DatabaseFieldKind,
  DatabaseProfileKind,
  DatabaseStatusGroup,
  databaseRowActivityQuery,
  deleteDatabaseRowMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  CopyIcon,
  MoreHorizontalIcon,
  OpenInNewIcon,
  TrashIcon,
} from "@myoxus/icons/react";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Badge,
  Button,
  DetailPeek,
  EmptyState,
  FormRow,
  Group,
  IconButton,
  InlineContentTrigger,
  FormSelect,
  Loading,
  Menu,
  MenuItem,
  MenuSectionLabel,
  MenuSeparator,
  MyoxusText,
  Notice,
  RichTextInput,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  SurfaceListText,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  createContext,
  Fragment,
  type Ref,
  type RefObject,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  DatabaseCellEditor,
  DatabaseTagBadges,
  stringArrayCellValue,
} from "../cells";
import {
  DatabaseRichTextCell,
  type DatabaseRichTextCellHandle,
  type DatabaseRichTextValue,
} from "../cells/rich-text-cell";
import {
  formatCellValue,
  getCellPrimitiveValue,
  getCellValue,
  getSelectOptions,
} from "../model";
import { useDatabaseConflictController } from "../presence";
import { DatabasePresenceTarget } from "../presence/database-presence-target";
import { executeRevisionMutation } from "../presence/execute-revision-mutation";
import { DatabaseActivityList, ROW_ACTIVITY_I18N_KEYS } from "../row-activity";
import type { DatabaseChangeHandler } from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
} from "../types";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import { useTaskFreshness } from "../tasks/use-task-freshness";
import { databaseManagedCapabilities, managedTaskFields } from "../managed";
import {
  databaseFieldDisplayName,
  databaseOptionDisplayName,
  taskOptionDisplayName,
} from "../presentation/task-labels";
import { TaskMoveModal } from "../tasks/task-move-modal";
import type { TaskMoveRetentionSlot } from "../tasks/task-move-controller";
import { openDatabaseDialogAfterMenuClose } from "../view-controls";
import { TaskFollowMenuItem } from "./task-follow-menu-item";
import { DatabaseTaskRelationsSection } from "./task-relations-section";
import { DatabaseTaskBlockingSection } from "./task-blocking-section";
import { DatabaseRowSource } from "./row-source";
import {
  TaskDetailNavigationContext,
  type TaskDetailEditorIntent,
  type TaskDetailEditSession,
} from "./task-navigation";
import {
  hasMeaningfulTaskValue,
  resolveDatabaseRowFieldLayout,
} from "./field-role-resolver";
import { AssistantGroups } from "../presentation/renderer";
import { useAssistantPresentation } from "../presentation/use-assistant-presentation";
import { useAssistantPackage } from "../presentation/use-assistant-package";
import { useTaskStatusAction } from "../tasks/use-task-status-action";
import {
  DatabaseReminderControl,
  DatabaseReminderPresentation,
} from "../cells/reminder-control";

import {
  DatabaseRowContent,
  type DatabaseRowContentController,
  useDatabaseRowContentController,
} from "./row-content";

export type DatabaseRowDetailLoadState =
  "forbidden" | "loading" | "missing" | "unavailable";

export type DatabaseRowDetailContextValue = {
  canEdit: boolean;
  copyLink?: (row: DatabaseRowRecord) => void;
  open: (row: DatabaseRowRecord, trigger?: HTMLElement | null) => void;
  /** Explicit navigation may resolve a Row outside the current View window. */
  openById?: (rowId: string, trigger?: HTMLElement | null) => void;
};

export const DatabaseRowDetailContext =
  createContext<DatabaseRowDetailContextValue | null>(null);

export function useDatabaseRowDetail() {
  return useContext(DatabaseRowDetailContext);
}

// The detail keeps its guarded editor lifetime; its header menu only routes
// commands to that owner. List menus never mount another editor controller.
const TaskDetailCommands = createContext<{
  relationships: ReactNode;
  documents: ReactNode;
} | null>(null);

/** Notify the consumer after canonical readback, including confirmed Force. */
export function useDeleteDatabaseRowAction(
  databaseId: string,
  onChanged: DatabaseChangeHandler,
  onDeleted?: (rowId: string) => void,
) {
  const t = useI18n();
  const conflicts = useDatabaseConflictController();
  const mutation = useMutation({ mutation: deleteDatabaseRowMutation });
  return useCallback(
    (row: DatabaseRowRecord) => {
      const refreshDeletedRow = async () => {
        await onChanged({ kind: "row_deleted", target: { rowId: row.row.id } });
        onDeleted?.(row.row.id);
      };
      return executeRevisionMutation(
        conflicts,
        mutation.trigger,
        {
          databaseId,
          rowId: row.row.id,
          expectedEditRevision: row.row.editRevision,
        },
        {
          attemptedAction:
            row.row.rowKind === "task"
              ? t["com.myoxus.moveToTrash.title"]()
              : t["com.myoxus.database.row.delete"](),
          localValue: row.row.title,
          reloadLatest: () => onChanged(),
          afterSuccess: refreshDeletedRow,
        },
      );
    },
    [conflicts, databaseId, mutation.trigger, onChanged, onDeleted, t],
  );
}

export function DatabaseRowTitle({
  databaseId,
  onChanged,
  onInlineEditChange,
  onRequestInlineEdit,
  record,
  row,
  rows,
  titleField,
  viewId,
  displayLineClamp,
  withPresence = true,
}: {
  databaseId: string;
  onChanged: DatabaseChangeHandler;
  onInlineEditChange?: (editing: boolean) => void;
  onRequestInlineEdit?: (start: () => void) => void;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  rows: DatabaseRowRecord[];
  titleField: DatabaseField;
  viewId: string;
  displayLineClamp?: number | false;
  withPresence?: boolean;
}) {
  if (row.redacted) {
    return (
      <SurfaceListText kind="card-title" component="span">
        {row.row.title}
      </SurfaceListText>
    );
  }
  const editor = (
    <DatabaseCellEditor
      databaseId={databaseId}
      inlineDisplayLineClamp={displayLineClamp}
      field={titleField}
      record={record}
      row={row}
      rows={rows}
      onChanged={onChanged}
      onInlineEditChange={onInlineEditChange}
      onRequestInlineEdit={onRequestInlineEdit}
      inlineEditTrigger="click"
    />
  );
  return withPresence ? (
    <DatabasePresenceTarget rowId={row.row.id} viewId={viewId}>
      {editor}
    </DatabasePresenceTarget>
  ) : (
    editor
  );
}

export function DatabaseRowStateBadges({ row }: { row: DatabaseRowRecord }) {
  const t = useI18n();
  if (!row.redacted && !row.row.deletedAt) return null;
  return (
    <Group gap="xs" wrap="wrap">
      {row.redacted ? (
        <Badge tone="warning">{t["com.myoxus.database.row.redacted"]()}</Badge>
      ) : null}
      {row.row.deletedAt ? (
        <Badge tone="neutral">
          {t["com.myoxus.documentGraph.state.deleted"]()}
        </Badge>
      ) : null}
    </Group>
  );
}

export function DatabaseRowActionMenu({
  onCopyLink,
  onDelete,
  row,
  showOpenDetails = true,
  record,
  onChanged,
  canEdit: canEditOverride,
  additionalItems,
}: {
  onCopyLink?: () => void;
  onDelete?: () => void;
  additionalItems?: ReactNode;
  row: DatabaseRowRecord;
  showOpenDetails?: boolean;
  record?: DatabaseRecord;
  onChanged?: DatabaseChangeHandler;
  canEdit?: boolean;
}) {
  const t = useI18n();
  const detail = useDatabaseRowDetail();
  const commands = useContext(TaskDetailCommands);
  const navigation = useContext(TaskDetailNavigationContext);
  const canEdit = canEditOverride ?? detail?.canEdit ?? true;
  const copyLink =
    onCopyLink ?? (detail?.copyLink ? () => detail.copyLink?.(row) : undefined);
  const managedTask = Boolean(
    record?.managedSchema && row.row.rowKind === "task",
  );
  const presentation = useAssistantPackage(
    AssistantContext.TaskDetail,
    managedTask,
  );
  const controls =
    presentation.descriptor?.presentation.steps.flatMap((step) =>
      step.groups.flatMap((group) => group.controls),
    ) ?? [];
  const allows = (kind: AssistantControlKind) =>
    !managedTask || controls.some((control) => control.kind === kind);
  const assistanceMenu = useContextDocumentMenu();
  const taskTitleField = record
    ? managedTaskFields(record)?.get("task.title")
    : undefined;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const { identity: reviewActor } = useTaskIdentity();
  const reviewIdentity = JSON.stringify([
    reviewActor,
    record?.database.id,
    row.row.id,
  ]);
  const [reviewSession, setReviewSession] = useState<string | null>(null);
  const [reviewAvailable, setReviewAvailable] = useState<string | null>(null);
  const reviewAvailabilityChanged = useCallback(
    (available: boolean) =>
      setReviewAvailable(available ? reviewIdentity : null),
    [reviewIdentity],
  );
  const moveRetention = useRef<TaskMoveRetentionSlot["current"]>(undefined);
  // Only the selected detail owns the review read/recovery lifetime. Mounting
  // it in each list menu would fan out reads and lose the owner on menu close.
  const reviewEnabled = Boolean(
    managedTask && !showOpenDetails && !row.redacted && !row.row.deletedAt,
  );
  const openDetailDialog = (open: () => void) =>
    openDatabaseDialogAfterMenuClose(() => {
      if (navigation?.requestLeave) navigation.requestLeave(open);
      else open();
    });
  const canMove = Boolean(
    record &&
    databaseManagedCapabilities(record).workspaceTasks &&
    databaseManagedCapabilities(record).ready &&
    canEdit &&
    onChanged &&
    row.row.rowKind === "task" &&
    !row.row.deletedAt &&
    !row.redacted,
  );
  const reviewItem =
    reviewEnabled && reviewAvailable === reviewIdentity ? (
      <MenuItem
        data-testid="task-document-review"
        onSelect={() =>
          openDetailDialog(() => setReviewSession(reviewIdentity))
        }
      >
        {t["com.myoxus.database.review.details"]()}
      </MenuItem>
    ) : null;
  return (
    <>
      <TaskFollowMenuItem
        enabled={allows(AssistantControlKind.Follow)}
        record={record}
        row={row}
        canEdit={canEdit}
        onChanged={onChanged}
      >
        {(followItem) => (
          <Menu
            items={
              <>
                {managedTask ? (
                  <MenuSectionLabel>
                    {t["com.myoxus.common.task-actions"]()}
                  </MenuSectionLabel>
                ) : null}
                {additionalItems}
                {managedTask &&
                record &&
                taskTitleField &&
                !row.redacted &&
                !row.row.deletedAt
                  ? assistanceMenu({
                      databaseId: record.database.id,
                      taskId: row.row.id,
                      title: formatCellValue(row, taskTitleField, t.language),
                      projectId: databaseManagedCapabilities(record)
                        .workspaceTasks
                        ? undefined
                        : record.database.id,
                      returnFocusRef: triggerRef,
                    })
                  : null}
                {followItem}
                {canMove ? (
                  <MenuItem
                    data-testid="task-move-to-project"
                    onSelect={() => openDetailDialog(() => setMoveOpen(true))}
                  >
                    {t["com.myoxus.database.tasks.move-to-project"]()}
                  </MenuItem>
                ) : null}
                {detail && showOpenDetails ? (
                  <MenuItem
                    prefix={<OpenInNewIcon />}
                    onSelect={() => detail.open(row, triggerRef.current)}
                  >
                    {t["com.myoxus.database.row.open-details"]()}
                  </MenuItem>
                ) : null}
                {copyLink ? (
                  <MenuItem prefix={<CopyIcon />} onSelect={copyLink}>
                    {t["com.myoxus.database.view.copy-link"]()}
                  </MenuItem>
                ) : null}
                {commands?.relationships ? (
                  <>
                    <MenuSeparator />
                    <MenuSectionLabel>
                      {t["com.myoxus.common.relationships"]()}
                    </MenuSectionLabel>
                    {commands.relationships}
                  </>
                ) : null}
                {commands?.documents || reviewItem ? (
                  <>
                    <MenuSeparator />
                    <MenuSectionLabel>
                      {t["com.myoxus.common.document-actions"]()}
                    </MenuSectionLabel>
                    {reviewItem}
                    {commands?.documents}
                  </>
                ) : null}
                {onDelete &&
                canEdit &&
                allows(AssistantControlKind.RowLifecycle) ? (
                  <Fragment>
                    <MenuSeparator />
                    <MenuItem
                      type="danger"
                      prefix={<TrashIcon />}
                      onSelect={onDelete}
                    >
                      {managedTask
                        ? t["com.myoxus.moveToTrash.title"]()
                        : t["com.myoxus.database.row.delete"]()}
                    </MenuItem>
                  </Fragment>
                ) : null}
              </>
            }
          >
            <IconButton
              ref={triggerRef}
              aria-label={
                managedTask
                  ? t["com.myoxus.common.task-actions"]()
                  : t["com.myoxus.database.row.menu"]()
              }
              data-testid="database-row-action-menu"
            >
              <MoreHorizontalIcon />
            </IconButton>
          </Menu>
        )}
      </TaskFollowMenuItem>
      {reviewEnabled && record && onChanged ? (
        <DocumentReviewTask
          databaseId={record.database.id}
          rowId={row.row.id}
          revision={JSON.stringify([row.row.editRevision, row.cellRevisions])}
          onChanged={onChanged}
          presentation={{
            open: reviewSession === reviewIdentity,
            onClose: () => setReviewSession(null),
            onAvailable: reviewAvailabilityChanged,
            returnFocusRef: triggerRef,
          }}
        />
      ) : null}
      {moveOpen && record && onChanged ? (
        <TaskMoveModal
          record={record}
          row={row}
          retention={moveRetention}
          onChanged={onChanged}
          onClose={() => setMoveOpen(false)}
          returnFocusRef={triggerRef}
        />
      ) : null}
    </>
  );
}

export function DatabaseViewFieldValues({
  autoFocus = false,
  databaseId,
  fields,
  onChanged,
  record,
  row,
  rows,
  showLabels,
  readonly = false,
  compact = false,
  expandedEditors = false,
  valuesOnly = false,
  onInlineEditChange,
  richTextHandleRef,
  onRichTextDraftStateChange,
  onEditSessionChange,
  dueOpenRequest,
  onDueCancel,
  roleByFieldId,
}: {
  autoFocus?: boolean;
  databaseId: string;
  fields: DatabaseField[];
  onChanged: DatabaseChangeHandler;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  rows: DatabaseRowRecord[];
  showLabels?: boolean;
  readonly?: boolean;
  /** Read-only summaries retain full values in the canonical detail and tooltip. */
  compact?: boolean;
  expandedEditors?: boolean;
  valuesOnly?: boolean;
  onInlineEditChange?: (editing: boolean) => void;
  richTextHandleRef?: Ref<DatabaseRichTextCellHandle>;
  onRichTextDraftStateChange?: (state: {
    dirty: boolean;
    pending: boolean;
  }) => void;
  onEditSessionChange?: (session: TaskDetailEditSession | null) => void;
  dueOpenRequest?: number;
  onDueCancel?: () => void;
  roleByFieldId?: ReadonlyMap<string, DatabaseRecord["fieldRoles"][number]>;
}) {
  const t = useI18n();
  const regionalPreferences = useRegionalPreferences();
  if (row.redacted) {
    return (
      <MyoxusText tone="secondary">
        {t["com.myoxus.database.row.redacted"]()}
      </MyoxusText>
    );
  }
  return (
    <Stack gap="xs">
      {fields.map((field) => {
        const semanticRoleKey = roleByFieldId?.get(field.id)?.roleKey;
        const fieldName = databaseFieldDisplayName(t, record, row, field);
        const hasReadonlySemanticControl =
          semanticRoleKey === "task.progress" ||
          semanticRoleKey === "task.priority" ||
          semanticRoleKey === "task.complexity" ||
          semanticRoleKey === "task.parent" ||
          (record.database.profileKind === DatabaseProfileKind.Project &&
            row.row.rowKind === "task" &&
            field.fieldType === DatabaseFieldKind.DateTime);
        // Project role requiredness protects the schema role from deletion; it
        // does not make every task cell mandatory.
        const missingRequiredValue =
          field.required && !semanticRoleKey && !getCellValue(row, field.id);
        const primitive = getCellPrimitiveValue(row, field);
        const unavailable = t["com.myoxus.template-list.unavailable"]();
        const optionIds =
          field.fieldType === DatabaseFieldKind.MultiSelect
            ? stringArrayCellValue(primitive)
            : typeof primitive === "string" && primitive
              ? [primitive]
              : [];
        const options = getSelectOptions(field);
        const optionLabel = (
          option: { id: string; name: string } | undefined,
        ) =>
          option
            ? databaseOptionDisplayName(t, record, row, field, option)
            : unavailable;
        const selectedOptions = optionIds.map((id) =>
          options.find((option) => option.id === id),
        );
        let formatted = formatCellValue(
          row,
          field,
          t.language,
          { checkboxTrue: t["com.myoxus.database.cell.checked"]() },
          regionalPreferences,
        );
        if (field.fieldType === DatabaseFieldKind.Relation) {
          const targets = new Map(
            (getCellValue(row, field.id)?.value.relationTargets ?? []).map(
              (target) => [target.rowId, target],
            ),
          );
          formatted = stringArrayCellValue(primitive)
            .map((id) => {
              const target = targets.get(id);
              return target && !target.deleted && !target.redacted
                ? (target.title ?? "")
                : unavailable;
            })
            .join(", ");
        }
        if (
          [
            DatabaseFieldKind.Select,
            DatabaseFieldKind.Status,
            DatabaseFieldKind.MultiSelect,
          ].includes(field.fieldType)
        ) {
          formatted = selectedOptions
            .map((option) => optionLabel(option))
            .join(", ");
        }
        return (
          <Stack key={field.id} gap="xs">
            {showLabels ? (
              <MyoxusText tone="secondary" typographySlot="body-small">
                {fieldName}
              </MyoxusText>
            ) : null}
            {readonly &&
            !compact &&
            field.fieldType === DatabaseFieldKind.RichText ? (
              <DatabaseRichTextCell
                expanded
                fieldName={fieldName}
                readOnly
                value={
                  getCellPrimitiveValue(row, field) as DatabaseRichTextValue
                }
              />
            ) : readonly &&
              (field.fieldType === DatabaseFieldKind.User ||
                field.fieldType === DatabaseFieldKind.Users) ? (
              <InlineMemberList
                members={
                  field.fieldType === DatabaseFieldKind.User
                    ? typeof primitive === "string" && primitive
                      ? [primitive]
                      : []
                    : stringArrayCellValue(primitive)
                }
              />
            ) : readonly && field.fieldType === DatabaseFieldKind.Tags ? (
              <DatabaseTagBadges tagIds={stringArrayCellValue(primitive)} />
            ) : readonly &&
              compact &&
              [
                DatabaseFieldKind.Select,
                DatabaseFieldKind.Status,
                DatabaseFieldKind.MultiSelect,
              ].includes(field.fieldType) ? (
              selectedOptions.length ? (
                <Group wrap="wrap">
                  {selectedOptions.map((option, index) => (
                    <Badge
                      key={optionIds[index]}
                      tagColorRole={
                        isWorkspaceTagColorRole(option?.colorRole)
                          ? option.colorRole
                          : undefined
                      }
                    >
                      {optionLabel(option)}
                    </Badge>
                  ))}
                </Group>
              ) : (
                <MyoxusText typographySlot="body-small">
                  {t["com.myoxus.database.cell.empty"]()}
                </MyoxusText>
              )
            ) : readonly && (valuesOnly || !hasReadonlySemanticControl) ? (
              <Tooltip
                content={compact ? formatted : undefined}
                events={{ hover: true, focus: true, touch: false }}
              >
                <MyoxusText
                  tone="primary"
                  typographySlot="body-small"
                  lineClamp={compact ? 2 : undefined}
                >
                  {formatted || t["com.myoxus.database.cell.empty"]()}
                </MyoxusText>
              </Tooltip>
            ) : (
              <DatabaseCellEditor
                autoFocus={autoFocus}
                databaseId={databaseId}
                field={field}
                record={record}
                row={row}
                rows={rows}
                onChanged={onChanged}
                expanded={expandedEditors}
                onInlineEditChange={onInlineEditChange}
                richTextHandleRef={richTextHandleRef}
                onRichTextDraftStateChange={onRichTextDraftStateChange}
                onEditSessionChange={onEditSessionChange}
                dueOpenRequest={dueOpenRequest}
                onDueCancel={onDueCancel}
                readonly={readonly}
                semanticRoleKey={semanticRoleKey}
              />
            )}
            {missingRequiredValue && !(readonly && compact) ? (
              <MyoxusText
                tone="danger"
                typographySlot="body-small"
                data-testid="database-required-field-error"
              >
                {t["com.myoxus.page-properties.property.required"]()}
              </MyoxusText>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

type DatabaseRowDetailBodyProps = {
  activityOpen: boolean;
  canEdit: boolean;
  contentController: DatabaseRowContentController;
  databaseId: string;
  includeTitle: boolean;
  headerActions?: ReactNode;
  restoreAction?: ReactNode;
  onActivityOpenChange: (open: boolean) => void;
  onChanged: DatabaseChangeHandler;
  /** Runs after an admitted managed presentation has mounted its native editors. */
  onPresentationReady?: () => void;
  focusDue?: number;
  onOpenTask?: (databaseId: string, rowId: string) => void;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  rows: DatabaseRowRecord[];
  viewId: string;
  workspaceId: string;
};

const ROW_ACTIVITY_QUERY_CONFIG = {
  suspense: false,
  suppressErrorNotification: true,
} as const;

/** Only the open Task activity owner consumes DB-scoped hints, including
 * bulk summaries without a Row target. Canonical reads own ACL and errors.
 */
function TaskActivityFreshness({
  databaseId,
  workspaceId,
  refresh,
}: {
  databaseId: string;
  workspaceId: string;
  refresh: () => Promise<unknown>;
}) {
  const owner = useTaskIdentity();
  useTaskFreshness(
    {
      ...owner,
      identity: owner.workspace.id === workspaceId ? owner.identity : null,
    },
    refresh,
    (message) =>
      message.workspaceId === workspaceId && message.databaseId === databaseId,
  );
  return null;
}

function DatabaseRowActivityPanel({
  active,
  taskDatabaseId,
  rowId,
  workspaceId,
}: {
  active: boolean;
  taskDatabaseId?: string;
  rowId: string;
  workspaceId: string;
}) {
  const t = useI18n();
  const { data, error, isLoading, mutate } = useQuery(
    active
      ? {
          query: databaseRowActivityQuery,
          variables: { rowId, skip: 0, take: 50, workspaceId },
        }
      : undefined,
    ROW_ACTIVITY_QUERY_CONFIG,
  );
  const entries = (data?.workspace?.databaseRowActivity ?? []).map((entry) => ({
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
    <>
      {active && taskDatabaseId ? (
        <TaskActivityFreshness
          databaseId={taskDatabaseId}
          workspaceId={workspaceId}
          refresh={() => mutate()}
        />
      ) : null}
      {error ? (
        <EmptyState
          title={t["com.myoxus.common.operation-failed"]()}
          cta={<Button onClick={() => void mutate()}>{t["Retry"]()}</Button>}
        />
      ) : (
        <DatabaseActivityList
          emptyDescription={t[
            "com.myoxus.database.activity.drawer-empty-description"
          ]()}
          emptyTitle={t["com.myoxus.database.activity.drawer-empty"]()}
          entries={entries}
          label={t["com.myoxus.database.row_menu.view-activity"]()}
          loading={isLoading}
          resolveEventTypeLabel={(eventType) =>
            ROW_ACTIVITY_I18N_KEYS[
              eventType as keyof typeof ROW_ACTIVITY_I18N_KEYS
            ] ?? null
          }
          testIdPrefix="database-row-activity"
        />
      )}
    </>
  );
}

function DatabaseRowDetailBody(props: DatabaseRowDetailBodyProps) {
  return props.record.database.profileKind === DatabaseProfileKind.Project &&
    props.row.row.rowKind === "task" ? (
    <ManagedDatabaseRowDetailBody
      key={`${props.databaseId}:${props.row.row.id}`}
      {...props}
    />
  ) : (
    <GenericDatabaseRowDetailBody {...props} />
  );
}

function ManagedDatabaseRowDetailBody({
  activityOpen,
  canEdit: mayEdit,
  contentController,
  databaseId,
  includeTitle,
  headerActions,
  restoreAction,
  onActivityOpenChange,
  onChanged,
  onPresentationReady,
  focusDue,
  onOpenTask,
  record,
  row,
  rows,
  viewId,
  workspaceId,
}: DatabaseRowDetailBodyProps) {
  const t = useI18n();
  const editorIdentity = useTaskIdentity().identity;
  const canCreate = useLiveData(
    useService(GuardService).can$("Workspace_CreateDoc"),
  );
  const canEdit = mayEdit && !row.row.deletedAt && !row.redacted;
  const revision = JSON.stringify([
    row.row.editRevision,
    row.cellRevisions,
    record.managedSchema?.schemaRevision,
  ]);
  const presentation = useAssistantPresentation(
    AssistantContext.TaskDetail,
    databaseId,
    row.row.id,
    revision,
  );
  const catalog = useAssistantPackage(AssistantContext.TaskDetail);
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [dueOpenRequest, setDueOpenRequest] = useState(0);
  const fieldEditorRef = useRef<HTMLDivElement>(null);
  const addPropertyRef = useRef<HTMLButtonElement>(null);
  const propertyTrigger = useRef<HTMLElement | null>(null);
  const propertyTriggers = useRef(new Map<string, HTMLButtonElement>());
  const activeFieldIdentity = useRef(activeFieldId);
  activeFieldIdentity.current = activeFieldId;
  const navigation = useContext(TaskDetailNavigationContext);
  const richTextHandle = useRef<DatabaseRichTextCellHandle>(null);
  const [draftState, setDraftState] = useState({
    dirty: false,
    pending: false,
  });
  const registerEditor = navigation?.registerEditor;
  const activeDue = Boolean(
    activeFieldId &&
    managedTaskFields(record)?.get("task.dueDate")?.id === activeFieldId &&
    record.fields.some(
      (field) =>
        field.id === activeFieldId &&
        field.fieldType === DatabaseFieldKind.DateTime,
    ),
  );
  // A new opening owns a new token, including A→B→A field switches. Old Cell
  // cleanup callbacks cannot unregister a later editor for the same field ID.
  const dueEditorOwner = useMemo(
    () => ({}),
    [
      activeFieldId,
      editorIdentity,
      workspaceId,
      databaseId,
      row.row.id,
      canEdit,
      registerEditor,
    ],
  );
  const currentDueEditorOwner = useRef(dueEditorOwner);
  const dueEditorMounted = useRef(true);
  useEffect(() => {
    dueEditorMounted.current = true;
    return () => {
      dueEditorMounted.current = false;
    };
  }, []);
  currentDueEditorOwner.current = dueEditorOwner;
  const [dueEdit, setDueEdit] = useState<{
    owner: object;
    session: TaskDetailEditSession | null;
  }>();
  const onDueEditSessionChange = useCallback(
    (session: TaskDetailEditSession | null) => {
      if (
        !dueEditorMounted.current ||
        currentDueEditorOwner.current !== dueEditorOwner
      )
        return;
      setDueEdit({ owner: dueEditorOwner, session });
    },
    [dueEditorOwner],
  );
  const dueSession =
    activeDue && dueEdit?.owner === dueEditorOwner ? dueEdit.session : null;
  const activeRichText = record.fields.some(
    (field) =>
      field.id === activeFieldId &&
      field.fieldType === DatabaseFieldKind.RichText,
  );
  // A closed editor cannot keep the surrounding task locked after saving.
  const richTextPending = activeRichText && draftState.pending;
  const activeMemberPicker = record.fields.some(
    (field) =>
      field.id === activeFieldId &&
      (field.fieldType === DatabaseFieldKind.User ||
        field.fieldType === DatabaseFieldKind.Users),
  );
  const [editorIntent, setEditorIntent] = useState<TaskDetailEditorIntent>();
  const setDetailEditor = (kind: TaskDetailEditorIntent["kind"]) =>
    setEditorIntent((current) => ({
      kind,
      sequence: (current?.sequence ?? 0) + 1,
    }));
  const withEditorLeave = (next: () => void) => {
    if (navigation?.requestLeave) navigation.requestLeave(next);
    else next();
  };
  const ownsEditor = useRef(false);
  const [extraSections, setExtraSections] = useState<readonly string[]>([]);
  const revealSection = (section: string) =>
    openDatabaseDialogAfterMenuClose(() =>
      withEditorLeave(() => {
        setDetailEditor("close");
        setExtraSections((current) =>
          current.includes(section) ? current : [...current, section],
        );
      }),
    );
  const descriptor = presentation.descriptor;
  const projection = presentation.projection;
  const admitted = Boolean(
    descriptor &&
    projection?.databaseId === databaseId &&
    projection.rowId === row.row.id &&
    projection.managedSchema?.schemaRevision ===
      record.managedSchema?.schemaRevision,
  );
  const statusAction = useTaskStatusAction(async () => {
    await onChanged();
  }, canEdit && admitted);
  const statusPending = Boolean(statusAction.pending || statusAction.uncertain);
  useEffect(() => {
    // Deferred editors and the native due popover own their initial input focus.
    if (
      !activeFieldId ||
      !admitted ||
      activeRichText ||
      activeMemberPicker ||
      activeDue
    )
      return;
    const root = fieldEditorRef.current;
    // Native date pickers also mount a hidden submission input.
    const control =
      root?.querySelector<HTMLElement>(
        'input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), [contenteditable="true"], [role="slider"], [role="combobox"]',
      ) ?? root?.querySelector<HTMLElement>("button:not(:disabled)");
    control?.focus();
  }, [activeFieldId, admitted, activeRichText, activeMemberPicker, activeDue]);
  useEffect(() => {
    // The single navigation guard belongs to the active editor. An idle detail
    // must not unregister a subtask draft owned by its mounted child editor.
    if ((canEdit && (activeRichText || statusPending)) || dueSession) {
      ownsEditor.current = true;
      registerEditor?.({
        dirty: Boolean(
          (activeRichText && draftState.dirty) || dueSession?.dirty,
        ),
        pending:
          statusPending || richTextPending || Boolean(dueSession?.pending),
        apply: () =>
          dueSession
            ? dueSession.apply()
            : (richTextHandle.current?.saveDraft() ?? Promise.resolve(false)),
        discard: () =>
          dueSession
            ? dueSession.discard()
            : richTextHandle.current?.discardDraft(),
      });
    } else if (ownsEditor.current) {
      ownsEditor.current = false;
      registerEditor?.(null);
    }
  }, [
    registerEditor,
    canEdit,
    activeRichText,
    draftState.dirty,
    richTextPending,
    statusPending,
    dueSession,
  ]);
  useEffect(
    () => () => {
      if (ownsEditor.current) {
        ownsEditor.current = false;
        registerEditor?.(null);
      }
    },
    [registerEditor, activeFieldId],
  );
  const consumedFocusDue = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!focusDue || !admitted || consumedFocusDue.current === focusDue) return;
    const fieldId = managedTaskFields(record)?.get("task.dueDate")?.id;
    if (!fieldId) return;
    // Consume before asking to leave: Stay cancels this intent, and a later
    // record refresh must not reopen or replace an edited property.
    consumedFocusDue.current = focusDue;
    if (activeFieldIdentity.current === fieldId) {
      if (!dueSession?.pending && !statusPending)
        setDueOpenRequest((request) => request + 1);
      return;
    }
    const open = () => {
      setEditorIntent((current) => ({
        kind: "close",
        sequence: (current?.sequence ?? 0) + 1,
      }));
      setActiveFieldId(fieldId);
      setDueOpenRequest((request) => request + 1);
    };
    if (navigation?.requestLeave) navigation.requestLeave(open);
    else open();
  }, [
    focusDue,
    admitted,
    record,
    navigation?.requestLeave,
    dueSession?.pending,
    statusPending,
  ]);
  useEffect(() => {
    // Native data may arrive before the file-authored editors. A navigation
    // focus request must wait for the admitted presentation's DOM commit.
    if (admitted) onPresentationReady?.();
  }, [admitted, descriptor, activeFieldId, onPresentationReady]);
  const backAction = navigation?.back ? (
    <Button type="button" variant="secondary" onClick={navigation.back}>
      {t["com.myoxus.backButton"]()}
    </Button>
  ) : null;
  if (!descriptor || !projection || !admitted) {
    return (
      <DatabaseReminderPresentation.Provider value={null}>
        <Stack data-testid="database-row-detail-content">
          <DatabaseRowStateBadges row={row} />
          <Group align="flex-start" justify="space-between" wrap="nowrap">
            {backAction}
            {includeTitle ? (
              <MyoxusText component="div" typographySlot="h2">
                {row.row.title}
              </MyoxusText>
            ) : null}
            {headerActions}
          </Group>
          <Group>{row.row.deletedAt ? restoreAction : null}</Group>
          {presentation.isLoading ? (
            <Loading />
          ) : (
            <Notice tone="warning">
              <Button
                onClick={() => {
                  void onChanged();
                  void presentation.mutate();
                }}
              >
                {t.Retry()}
              </Button>
            </Notice>
          )}
        </Stack>
      </DatabaseReminderPresentation.Provider>
    );
  }
  const groups = descriptor.presentation.steps.flatMap((step) => step.groups);
  const reminder =
    groups
      .flatMap((group) => group.controls)
      .find((control) => control.kind === AssistantControlKind.Reminder) ??
    null;
  const roles = new Map(
    record.fieldRoles
      .filter(
        (role) =>
          role.rowKindScope === row.row.rowKind &&
          projection.fields.some(
            (field) =>
              field.fieldId === role.fieldId &&
              field.binding.roleKey === role.roleKey,
          ),
      )
      .map((role) => [role.fieldId, role]),
  );
  const matchingCatalog =
    catalog.descriptor?.identity.digest === descriptor.identity.digest &&
    catalog.descriptor.identity.id === descriptor.identity.id &&
    catalog.descriptor.identity.version === descriptor.identity.version
      ? catalog.descriptor
      : null;
  const declared =
    matchingCatalog?.presentation.steps.flatMap((step) =>
      step.groups.flatMap((group) => group.controls),
    ) ?? [];
  // The server admits bindings independently of presence-filtered controls.
  // Empty stored fields must remain available to the deliberate Add action.
  const fields = projection.fields.flatMap((resolved) => {
    const field = record.fields.find((field) => field.id === resolved.fieldId);
    return field ? [field] : [];
  });
  const taskFields = managedTaskFields(record);
  const titleField = taskFields?.get("task.title");
  const statusField = taskFields?.get("task.status");
  const dueField = taskFields?.get("task.dueDate");
  const statusValue = statusField
    ? (getCellPrimitiveValue(row, statusField) ??
      statusField.config.status?.defaultOptionId)
    : null;
  const status = statusField?.config.status?.options.find(
    (option) => option.id === statusValue,
  );
  const statusKnown = Boolean(status);
  const bindingRoles = new Map(
    [...(taskFields ?? [])].map(([role, field]) => [field.id, role]),
  );
  const roleKey = (field: DatabaseField) => bindingRoles.get(field.id);
  const fieldLabel = (field: DatabaseField) =>
    databaseFieldDisplayName(t, record, row, field);
  const attribution = (field: DatabaseField) =>
    ["task.assignedBy", "task.completedAt", "task.completedBy"].includes(
      roleKey(field) ?? "",
    ) ||
    [
      DatabaseFieldKind.CreatedBy,
      DatabaseFieldKind.CreatedTime,
      DatabaseFieldKind.UpdatedBy,
      DatabaseFieldKind.UpdatedTime,
      DatabaseFieldKind.UniqueId,
    ].includes(field.fieldType);
  const editableFields = fields.filter(
    (field) =>
      !attribution(field) &&
      !["task.title", "task.status", "task.parent", "task.blockedBy"].includes(
        roleKey(field) ?? "",
      ),
  );
  const primaryRoles = ["task.description", "task.dueDate", "task.assignees"];
  const missingFields = [
    ...primaryRoles.flatMap((role) =>
      editableFields.filter((field) => roleKey(field) === role),
    ),
    ...editableFields.filter(
      (field) => !primaryRoles.includes(roleKey(field) ?? ""),
    ),
  ].filter((field) => !hasMeaningfulTaskValue(row, field));
  const openField = (field: DatabaseField, trigger?: HTMLElement) => {
    propertyTrigger.current = trigger ?? addPropertyRef.current;
    openDatabaseDialogAfterMenuClose(() =>
      withEditorLeave(() => {
        setDetailEditor("close");
        setActiveFieldId(field.id);
        if (managedTaskFields(record)?.get("task.dueDate")?.id === field.id)
          setDueOpenRequest((request) => request + 1);
      }),
    );
  };
  const closeField = () => {
    const fieldId = activeFieldId;
    setActiveFieldId(null);
    requestAnimationFrame(() => {
      // Editing replaces the value trigger. Restore its new instance, unless
      // the leave guard has already admitted another field editor.
      if (activeFieldIdentity.current !== null) return;
      const trigger =
        (fieldId && propertyTriggers.current.get(fieldId)) ||
        propertyTrigger.current;
      (trigger?.isConnected ? trigger : addPropertyRef.current)?.focus();
    });
  };
  const requestDetailEditor = (kind: TaskDetailEditorIntent["kind"]) =>
    withEditorLeave(() => {
      setActiveFieldId(null);
      setDetailEditor(kind);
    });
  const openRelation = (kind: TaskDetailEditorIntent["kind"]) =>
    openDatabaseDialogAfterMenuClose(() => requestDetailEditor(kind));
  const editorChanged: DatabaseChangeHandler = async (reason) => {
    await onChanged(reason);
    closeField();
  };
  const descriptionField = fields.find(
    (field) => roleKey(field) === "task.description",
  );
  const metadataFields = fields.filter(
    (field) =>
      ["task.dueDate", "task.assignees"].includes(roleKey(field) ?? "") &&
      hasMeaningfulTaskValue(row, field),
  );
  const activeMetadataField = fields.find(
    (field) =>
      field.id === activeFieldId &&
      ["task.dueDate", "task.assignees"].includes(roleKey(field) ?? ""),
  );
  const secondaryFields = fields.filter(
    (field) =>
      ![
        "task.title",
        "task.status",
        "task.description",
        "task.dueDate",
        "task.assignees",
        "task.parent",
        "task.blockedBy",
      ].includes(roleKey(field) ?? "") &&
      (field.id === activeFieldId || hasMeaningfulTaskValue(row, field)),
  );
  const informationFields = secondaryFields.filter(attribution);
  const propertyFields = secondaryFields.filter((field) => !attribution(field));
  const hasSource = groups.some((group) =>
    group.controls.some(
      (control) => control.kind === AssistantControlKind.SourceOrigin,
    ),
  );
  const canParent =
    canEdit &&
    taskFields?.get("task.parent") &&
    declared.some((control) => control.kind === AssistantControlKind.Parent);
  const canBlock =
    canEdit &&
    taskFields?.get("task.blockedBy") &&
    declared.some((control) => control.kind === AssistantControlKind.BlockedBy);
  const relationships =
    canParent || canBlock ? (
      <>
        {canParent ? (
          <>
            {canCreate ? (
              <MenuItem
                disabled={Boolean(activeFieldId)}
                onSelect={() => openRelation("create")}
              >
                {t["com.myoxus.database.task-children.add"]()}
              </MenuItem>
            ) : null}
            <MenuItem
              disabled={Boolean(activeFieldId)}
              onSelect={() => openRelation("parent")}
            >
              {t["com.myoxus.database.task-parent.label"]()}
            </MenuItem>
          </>
        ) : null}
        {canBlock ? (
          <MenuItem
            disabled={Boolean(activeFieldId)}
            onSelect={() => openRelation("blockedBy")}
          >
            {t["com.myoxus.database.task-blocking.blocked-by"]()}
          </MenuItem>
        ) : null}
      </>
    ) : null;
  const documents = declared.some(
    (control) => control.kind === AssistantControlKind.RowContent,
  ) ? (
    <MenuItem
      disabled={Boolean(activeFieldId)}
      onSelect={() => revealSection("content")}
    >
      {t["com.myoxus.database.row_content.title"]()}
    </MenuItem>
  ) : null;
  const renderFieldEditor = (field: DatabaseField) => (
    <Stack ref={fieldEditorRef} data-testid="task-property-editor">
      <DatabaseViewFieldValues
        autoFocus
        databaseId={databaseId}
        fields={[field]}
        onChanged={editorChanged}
        record={record}
        row={row}
        rows={rows}
        readonly={!canEdit || attribution(field)}
        expandedEditors
        richTextHandleRef={richTextHandle}
        onRichTextDraftStateChange={setDraftState}
        onEditSessionChange={activeDue ? onDueEditSessionChange : undefined}
        dueOpenRequest={activeDue ? dueOpenRequest : undefined}
        onDueCancel={
          activeDue
            ? () => {
                if (
                  dueEditorMounted.current &&
                  currentDueEditorOwner.current === dueEditorOwner &&
                  activeFieldIdentity.current === field.id
                )
                  closeField();
              }
            : undefined
        }
        onInlineEditChange={(editing) => {
          if (!editing && field.fieldType === DatabaseFieldKind.RichText)
            closeField();
        }}
        roleByFieldId={roles}
      />
      {field.fieldType !== DatabaseFieldKind.RichText ? (
        <Button variant="secondary" onClick={() => withEditorLeave(closeField)}>
          {t["com.myoxus.peek-view-controls.close"]()}
        </Button>
      ) : null}
    </Stack>
  );
  const renderFieldValue = (field: DatabaseField, valueOnly = false) => {
    if (!valueOnly && activeFieldId === field.id)
      return renderFieldEditor(field);
    const value = (
      <DatabaseViewFieldValues
        databaseId={databaseId}
        fields={[field]}
        onChanged={onChanged}
        record={record}
        row={row}
        rows={rows}
        readonly
        valuesOnly
        roleByFieldId={roles}
      />
    );
    return canEdit && !attribution(field) ? (
      <InlineContentTrigger
        ref={(node) => {
          if (node) propertyTriggers.current.set(field.id, node);
          else propertyTriggers.current.delete(field.id);
        }}
        aria-label={fieldLabel(field)}
        disabled={
          statusPending ||
          richTextPending ||
          (valueOnly && activeFieldId === field.id)
        }
        onClick={(event) => openField(field, event.currentTarget)}
      >
        {value}
      </InlineContentTrigger>
    ) : (
      value
    );
  };
  const renderPropertyRows = (
    propertyFields: DatabaseField[],
    includeStatus = false,
  ) => (
    <Table>
      <TableBody>
        {includeStatus && statusField ? (
          <TableRow>
            <TableCell>
              <MyoxusText tone="secondary">
                {fieldLabel(statusField)}
              </MyoxusText>
            </TableCell>
            <TableCell>
              <FormSelect
                aria-label={fieldLabel(statusField)}
                value={status?.id ?? null}
                placeholder={t["com.myoxus.database.conflict.unknown"]()}
                data={(statusField.config.status?.options ?? []).map(
                  (option) => ({
                    value: option.id,
                    label: taskOptionDisplayName(t, "task.status", option.id),
                  }),
                )}
                disabled={
                  !canEdit || !statusKnown || statusPending || richTextPending
                }
                onChange={(value) =>
                  withEditorLeave(() => {
                    setActiveFieldId(null);
                    setDetailEditor("close");
                    void statusAction.change(
                      { databaseId, rowId: row.row.id },
                      value,
                    );
                  })
                }
              />
            </TableCell>
          </TableRow>
        ) : null}
        {propertyFields.map((field) => (
          <TableRow key={field.id}>
            <TableCell>
              <MyoxusText tone="secondary">{fieldLabel(field)}</MyoxusText>
            </TableCell>
            <TableCell>
              <Group wrap="nowrap">{renderFieldValue(field)}</Group>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  const descriptionValue = descriptionField
    ? (getCellPrimitiveValue(row, descriptionField) as DatabaseRichTextValue)
    : null;
  const descriptionContent =
    descriptionField && descriptionValue?.document ? (
      <RichTextInput
        aria-label={fieldLabel(descriptionField)}
        readOnly
        unstyled
        value={descriptionValue.document}
        onChange={() => {}}
      />
    ) : descriptionField ? (
      <DatabaseViewFieldValues
        databaseId={databaseId}
        fields={[descriptionField]}
        onChanged={onChanged}
        record={record}
        row={row}
        rows={rows}
        readonly
        valuesOnly
        roleByFieldId={roles}
      />
    ) : null;
  return (
    <DatabaseReminderPresentation.Provider value={reminder}>
      <Stack data-testid="database-row-detail-content">
        <DatabaseRowStateBadges row={row} />
        <Group align="flex-start" justify="space-between" wrap="nowrap">
          {backAction}
          {includeTitle && titleField ? (
            <MyoxusText component="div" typographySlot="h2">
              {canEdit ? (
                <DatabaseRowTitle
                  databaseId={databaseId}
                  onChanged={onChanged}
                  record={record}
                  row={row}
                  rows={rows}
                  titleField={titleField}
                  viewId={viewId}
                  displayLineClamp={false}
                  onRequestInlineEdit={(start) =>
                    withEditorLeave(() => {
                      setActiveFieldId(null);
                      setDetailEditor("close");
                      start();
                    })
                  }
                />
              ) : (
                row.row.title
              )}
            </MyoxusText>
          ) : null}
          <TaskDetailCommands.Provider value={{ relationships, documents }}>
            {headerActions}
          </TaskDetailCommands.Provider>
        </Group>
        {row.row.deletedAt ? restoreAction : null}
        {descriptionField &&
        (descriptionField.id === activeFieldId ||
          hasMeaningfulTaskValue(row, descriptionField)) ? (
          <Stack>
            <MyoxusText tone="secondary">
              {fieldLabel(descriptionField)}
            </MyoxusText>
            {descriptionField.id === activeFieldId ? (
              renderFieldEditor(descriptionField)
            ) : canEdit ? (
              <InlineContentTrigger
                ref={(node) => {
                  if (node)
                    propertyTriggers.current.set(descriptionField.id, node);
                  else propertyTriggers.current.delete(descriptionField.id);
                }}
                aria-label={fieldLabel(descriptionField)}
                disabled={statusPending || richTextPending}
                onClick={(event) =>
                  openField(descriptionField, event.currentTarget)
                }
              >
                {descriptionContent}
              </InlineContentTrigger>
            ) : (
              descriptionContent
            )}
          </Stack>
        ) : null}
        <Stack data-testid="database-row-detail-fields">
          {statusField ? renderPropertyRows([], true) : null}
          {metadataFields.length || dueField ? (
            <Group>
              {metadataFields
                .filter((field) => field.id !== dueField?.id)
                .map((field) => (
                  <Group key={field.id} wrap="nowrap">
                    {renderFieldValue(field, true)}
                  </Group>
                ))}
              {dueField ? (
                <Group wrap="nowrap">
                  {metadataFields.some((field) => field.id === dueField.id) ? (
                    <>
                      {renderFieldValue(dueField, true)}
                      {dueField.id !== activeFieldId ? (
                        <DatabaseReminderControl
                          field={dueField}
                          record={record}
                          row={row}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {/* Keep this owner mounted when adoption fills an absent Due,
                      so native Modal focus returns to the same stable trigger. */}
                  <TaskRecurrenceControl
                    record={record}
                    row={row}
                    onOpenTask={onOpenTask}
                    onRequestOpen={(open) =>
                      withEditorLeave(() => {
                        setActiveFieldId(null);
                        setDetailEditor("close");
                        open();
                      })
                    }
                    onEditOccurrence={
                      canEdit
                        ? () =>
                            openField(
                              dueField,
                              propertyTriggers.current.get(dueField.id),
                            )
                        : undefined
                    }
                    canConfigure={
                      canEdit &&
                      statusKnown &&
                      status?.group !== DatabaseStatusGroup.Complete &&
                      status?.group !== DatabaseStatusGroup.Archived
                    }
                    onChanged={onChanged}
                  />
                </Group>
              ) : null}
            </Group>
          ) : null}
          {activeMetadataField ? (
            <Stack>
              <MyoxusText tone="secondary">
                {fieldLabel(activeMetadataField)}
              </MyoxusText>
              {renderFieldEditor(activeMetadataField)}
            </Stack>
          ) : null}
          {propertyFields.length ? renderPropertyRows(propertyFields) : null}
          {canEdit && missingFields.length ? (
            <Menu
              items={missingFields.map((field) => (
                <MenuItem key={field.id} onSelect={() => openField(field)}>
                  {fieldLabel(field)}
                </MenuItem>
              ))}
            >
              <Button
                ref={addPropertyRef}
                variant="plain"
                disabled={!matchingCatalog || statusPending || richTextPending}
              >
                {t["com.myoxus.page-properties.add-property"]()}
              </Button>
            </Menu>
          ) : null}
        </Stack>
        {statusAction.failed || statusAction.uncertain ? (
          <Notice
            tone="warning"
            title={
              statusAction.uncertain
                ? statusAction.refreshFailed
                  ? t["com.myoxus.database.tasks.status-refresh-failed"]()
                  : t["com.myoxus.database.tasks.status-unconfirmed"]()
                : t["com.myoxus.common.operation-failed"]()
            }
          >
            {statusAction.uncertain ? (
              <Button
                disabled={Boolean(statusAction.pending)}
                onClick={() => void statusAction.recover()}
              >
                {t["com.myoxus.database.conflict.reload"]()}
              </Button>
            ) : null}
          </Notice>
        ) : null}
        {statusAction.undo ? (
          <Button
            disabled={Boolean(statusAction.pending || statusAction.uncertain)}
            onClick={() =>
              withEditorLeave(() => {
                setDetailEditor("close");
                void statusAction.undoLast();
              })
            }
          >
            {t.Undo()}
          </Button>
        ) : null}
        {informationFields.length || hasSource ? (
          <Accordion data-testid="task-information">
            <AccordionItem value="information">
              <AccordionControl>
                {t["com.myoxus.common.task-information"]()}
              </AccordionControl>
              <AccordionPanel>
                <Stack>
                  {informationFields.length
                    ? renderPropertyRows(informationFields)
                    : null}
                  {hasSource ? (
                    <DatabaseRowSource
                      workspaceId={workspaceId}
                      databaseId={databaseId}
                      rowId={row.row.id}
                      onOpenDoc={contentController.onOpenDoc}
                    />
                  ) : null}
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        ) : null}
        <AssistantGroups
          grouped={false}
          descriptor={descriptor}
          stepId={descriptor.presentation.steps[0]?.id}
          artworkServer={presentation.owner.server}
          groups={groups}
          answers={{}}
          disabled={!canEdit}
          renderGroup={(group, children) => {
            if (!group.controls.length) return null;
            if (group.role === AssistantGroupRole.More) return null;
            return children;
          }}
          adapters={{
            control: (control) => {
              switch (control.kind) {
                case AssistantControlKind.NativeCell:
                  // Values belong to their direct property or information row.
                  return null;
                case AssistantControlKind.SourceOrigin:
                  // Provenance is available on demand with the Task identity.
                  return null;
                case AssistantControlKind.Parent:
                  return (
                    <DatabaseTaskRelationsSection
                      hideEmpty
                      editorIntent={editorIntent}
                      onEditRequest={requestDetailEditor}
                      canEdit={canEdit}
                      onChanged={onChanged}
                      record={record}
                      row={row}
                      rows={rows}
                    />
                  );
                case AssistantControlKind.BlockedBy:
                  return (
                    <DatabaseTaskBlockingSection
                      hideEmpty
                      editorIntent={editorIntent}
                      onEditRequest={requestDetailEditor}
                      canEdit={canEdit}
                      onChanged={onChanged}
                      record={record}
                      row={row}
                      rows={rows}
                    />
                  );
                case AssistantControlKind.Reminder:
                  // The existing DateTime cell owns the personal reminder popover.
                  return null;
                case AssistantControlKind.RowContent:
                  if (!extraSections.includes("content"))
                    return row.row.contentDocument ? (
                      <DatabaseRowContent
                        controller={contentController}
                        compact
                      />
                    ) : null;
                  return (
                    <Accordion
                      defaultValue="page-content"
                      data-testid="database-row-page-content-section"
                    >
                      <AccordionItem value="page-content">
                        <AccordionControl>
                          {t["com.myoxus.database.row_content.title"]()}
                        </AccordionControl>
                        <AccordionPanel>
                          <DatabaseRowContent
                            controller={contentController}
                            showOpenCommand
                          />
                        </AccordionPanel>
                      </AccordionItem>
                    </Accordion>
                  );
                case AssistantControlKind.Activity:
                  return (
                    <Accordion
                      value={activityOpen ? "activity" : null}
                      onChange={(value) =>
                        onActivityOpenChange(value === "activity")
                      }
                      data-testid="database-row-activity-section"
                    >
                      <AccordionItem value="activity">
                        <AccordionControl>
                          {t["com.myoxus.database.row_menu.view-activity"]()}
                        </AccordionControl>
                        <AccordionPanel>
                          <DatabaseRowActivityPanel
                            active={activityOpen}
                            taskDatabaseId={databaseId}
                            rowId={row.row.id}
                            workspaceId={workspaceId}
                          />
                        </AccordionPanel>
                      </AccordionItem>
                    </Accordion>
                  );
                case AssistantControlKind.Follow:
                case AssistantControlKind.RowLifecycle:
                  // Native commands remain in the Row action menu.
                  return null;
                default:
                  return undefined;
              }
            },
          }}
        />
      </Stack>
    </DatabaseReminderPresentation.Provider>
  );
}

function GenericDatabaseRowDetailBody({
  activityOpen,
  canEdit,
  contentController,
  databaseId,
  includeTitle,
  onActivityOpenChange,
  onChanged,
  record,
  row,
  rows,
  viewId,
  workspaceId,
}: DatabaseRowDetailBodyProps) {
  const t = useI18n();
  const layout = resolveDatabaseRowFieldLayout(record, row);
  const { titleField } = layout;
  const morePropertyCount = layout.moreFields.length;

  return (
    <Stack gap="md" data-testid="database-row-detail-content">
      {row.redacted || row.row.deletedAt ? (
        <DatabaseRowStateBadges row={row} />
      ) : null}
      {includeTitle ? (
        <MyoxusText component="div" typographySlot="card-title">
          {canEdit ? (
            <DatabaseRowTitle
              databaseId={databaseId}
              displayLineClamp={2}
              onChanged={onChanged}
              record={record}
              row={row}
              rows={rows}
              titleField={titleField}
              viewId={viewId}
            />
          ) : (
            row.row.title
          )}
        </MyoxusText>
      ) : null}
      {row.row.rowKind === "task" ? (
        <DatabaseRowSource
          workspaceId={workspaceId}
          databaseId={databaseId}
          rowId={row.row.id}
          onOpenDoc={contentController.onOpenDoc}
        />
      ) : null}
      {record.database.profileKind === DatabaseProfileKind.Project &&
      row.row.rowKind === "task" &&
      !layout.descriptionField ? (
        <FormRow label={t["com.myoxus.common.description"]()}>
          <MyoxusText tone="secondary">
            {t["com.myoxus.database.cell.empty"]()}
          </MyoxusText>
        </FormRow>
      ) : null}
      {layout.descriptionField ? (
        <DatabaseViewFieldValues
          databaseId={databaseId}
          fields={[layout.descriptionField]}
          onChanged={onChanged}
          record={record}
          row={row}
          rows={rows}
          showLabels
          readonly={!canEdit}
          roleByFieldId={layout.roleByFieldId}
        />
      ) : null}
      {layout.workflowFields.length ? (
        <Stack gap="xs" data-testid="database-row-workflow-fields">
          <MyoxusText tone="secondary" typographySlot="body-small">
            {t["com.myoxus.document-metadata.section.workflow"]()}
          </MyoxusText>
          <DatabaseViewFieldValues
            databaseId={databaseId}
            fields={layout.workflowFields}
            onChanged={onChanged}
            record={record}
            row={row}
            rows={rows}
            showLabels
            readonly={!canEdit}
            expandedEditors
            roleByFieldId={layout.roleByFieldId}
          />
        </Stack>
      ) : null}
      <DatabaseTaskRelationsSection
        canEdit={canEdit}
        onChanged={onChanged}
        record={record}
        row={row}
        rows={rows}
      />
      <DatabaseTaskBlockingSection
        canEdit={canEdit}
        onChanged={onChanged}
        record={record}
        row={row}
        rows={rows}
      />
      {layout.detailFields.length ? (
        <Accordion data-testid="database-row-detail-fields">
          <AccordionItem value="details">
            <AccordionControl>
              {t["com.myoxus.database.create.assistant.step.details"]()}
            </AccordionControl>
            <AccordionPanel>
              <DatabaseViewFieldValues
                databaseId={databaseId}
                fields={layout.detailFields}
                onChanged={onChanged}
                record={record}
                row={row}
                rows={rows}
                showLabels
                readonly={!canEdit}
                expandedEditors
                roleByFieldId={layout.roleByFieldId}
              />
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      ) : null}
      {morePropertyCount ? (
        <Accordion data-testid="database-row-empty-properties">
          <AccordionItem value="empty-properties">
            <AccordionControl>
              {morePropertyCount === 1
                ? t["com.myoxus.page-properties.more-property.one"]({
                    count: "1",
                  })
                : t["com.myoxus.page-properties.more-property.more"]({
                    count: String(morePropertyCount),
                  })}
            </AccordionControl>
            <AccordionPanel>
              <DatabaseViewFieldValues
                databaseId={databaseId}
                fields={layout.moreFields}
                onChanged={onChanged}
                record={record}
                row={row}
                rows={rows}
                showLabels
                readonly={!canEdit}
                expandedEditors
                roleByFieldId={layout.roleByFieldId}
              />
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      ) : null}
      <Accordion data-testid="database-row-page-content-section">
        <AccordionItem value="page-content">
          <AccordionControl>
            {t["com.myoxus.database.row_content.title"]()}
          </AccordionControl>
          <AccordionPanel>
            <DatabaseRowContent
              controller={contentController}
              showOpenCommand
            />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
      <Accordion
        value={activityOpen ? "activity" : null}
        onChange={(value) => onActivityOpenChange(value === "activity")}
        data-testid="database-row-activity-section"
      >
        <AccordionItem value="activity">
          <AccordionControl>
            {t["com.myoxus.database.row_menu.view-activity"]()}
          </AccordionControl>
          <AccordionPanel>
            <DatabaseRowActivityPanel
              active={activityOpen}
              taskDatabaseId={
                record.database.profileKind === DatabaseProfileKind.Project &&
                row.row.rowKind === "task"
                  ? record.database.id
                  : undefined
              }
              rowId={row.row.id}
              workspaceId={workspaceId}
            />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Stack>
  );
}

export function DatabaseResolvedRowDetailPeekBody({
  canEdit,
  databaseId,
  onChanged,
  onOpenDoc,
  onPresentationReady,
  focusDue,
  onOpenTask,
  headerActions,
  restoreAction,
  record,
  row,
  rows,
  viewId,
  workspaceId,
}: Omit<
  DatabaseRowDetailBodyProps,
  "activityOpen" | "contentController" | "includeTitle" | "onActivityOpenChange"
> & {
  onOpenDoc: (docId: string) => void;
}) {
  const [activityOpen, setActivityOpen] = useState(false);
  const contentController = useDatabaseRowContentController({
    canEdit,
    databaseId,
    onChanged,
    onOpenDoc,
    row,
    workspaceId,
  });
  return (
    <DatabaseRowDetailBody
      activityOpen={activityOpen}
      canEdit={canEdit}
      contentController={contentController}
      databaseId={databaseId}
      includeTitle
      headerActions={headerActions}
      restoreAction={restoreAction}
      onActivityOpenChange={setActivityOpen}
      onChanged={onChanged}
      onPresentationReady={onPresentationReady}
      focusDue={focusDue}
      onOpenTask={onOpenTask}
      record={record}
      row={row}
      rows={rows}
      viewId={viewId}
      workspaceId={workspaceId}
    />
  );
}

export function DatabaseRowDetailPeek({
  canEdit,
  databaseId,
  onChanged,
  onClose,
  onDelete,
  onOpenDoc,
  record,
  returnFocusRef,
  row,
  loadState = null,
  rows,
  viewId,
  workspaceId,
}: {
  canEdit: boolean;
  databaseId: string;
  onChanged: DatabaseChangeHandler;
  onClose: () => void;
  onDelete?: (row: DatabaseRowRecord) => Promise<unknown> | void;
  onOpenDoc: (docId: string) => void;
  record: DatabaseRecord;
  returnFocusRef: RefObject<HTMLElement | null>;
  row: DatabaseRowRecord | null;
  loadState?: DatabaseRowDetailLoadState | null;
  rows: DatabaseRowRecord[];
  viewId: string;
  workspaceId: string;
}) {
  const t = useI18n();
  const title = row
    ? record.database.profileKind === DatabaseProfileKind.Project &&
      row.row.rowKind === "task"
      ? t["com.myoxus.database.row_detail.task-title"]()
      : t["com.myoxus.database.row_detail.title"]()
    : loadState === "loading"
      ? t["Loading"]()
      : loadState === "forbidden"
        ? t["com.myoxus.database.row_detail.forbidden"]()
        : loadState === "missing"
          ? t["com.myoxus.database.row_detail.missing"]()
          : t["com.myoxus.database.row_detail.unavailable"]();
  const managedTask =
    record.database.profileKind === DatabaseProfileKind.Project &&
    row?.row.rowKind === "task";
  const headerActions = row ? (
    <DatabaseRowActionMenu
      row={row}
      record={record}
      onChanged={onChanged}
      canEdit={canEdit}
      showOpenDetails={false}
      onDelete={
        canEdit && onDelete
          ? () => {
              void Promise.resolve(onDelete(row)).then((result) => {
                if (result !== undefined) onClose();
              });
            }
          : undefined
      }
    />
  ) : undefined;
  return (
    <DetailPeek
      open={Boolean(row) || Boolean(loadState)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title={title}
      actions={managedTask ? undefined : headerActions}
      closeButtonLabel={t["com.myoxus.peek-view-controls.close"]()}
      aria-label={t["com.myoxus.database.row.open-details"]()}
      data-testid="database-row-detail-peek"
    >
      {row ? (
        <DatabaseResolvedRowDetailPeekBody
          key={`${workspaceId}:${databaseId}:${row.row.id}`}
          headerActions={managedTask ? headerActions : undefined}
          canEdit={canEdit}
          databaseId={databaseId}
          onChanged={onChanged}
          onOpenDoc={onOpenDoc}
          record={record}
          row={row}
          rows={rows}
          viewId={viewId}
          workspaceId={workspaceId}
        />
      ) : loadState === "loading" ? (
        <Loading />
      ) : (
        <EmptyState
          data-testid={`database-row-detail-${loadState}`}
          title={title}
        />
      )}
    </DetailPeek>
  );
}
