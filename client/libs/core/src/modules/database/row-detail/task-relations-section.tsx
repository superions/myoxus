// SPDX-License-Identifier: AGPL-3.0-or-later

import { GuardService } from "@myoxus/core/modules/permissions";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  FormRow,
  Group,
  Loading,
  MyoxusText,
  SelectableCardRow,
  Stack,
  SurfaceList,
} from "@myoxus/ui-facade";
import { useCallback, useContext, useEffect, useRef, useState } from "react";

import { DatabaseCellEditor } from "../cells";
import { useTaskParentRead } from "../relation";
import { taskParentReason } from "../relation/task-parent-reason";
import type { DatabaseChangeHandler } from "../shared";
import { NewSubtask } from "../tasks/new-subtask";
import {
  type CreatedTask,
  taskCreationOwnerKey,
} from "../tasks/use-create-task";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import { resolveTaskParentProperty } from "./field-role-resolver";
import { useTaskChildren, useTaskRelationSummaries } from "./task-children";
import {
  TaskDetailNavigationContext,
  type TaskDetailEditSession,
  type TaskDetailEditorIntent,
} from "./task-navigation";

type Props = {
  canEdit: boolean;
  hideEmpty?: boolean;
  editorIntent?: TaskDetailEditorIntent;
  onEditRequest?: (kind: TaskDetailEditorIntent["kind"]) => void;
  onChanged: DatabaseChangeHandler;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  rows: DatabaseRowRecord[];
};

export function DatabaseTaskRelationsSection(props: Props) {
  if (!resolveTaskParentProperty(props.record, props.row) || props.row.redacted)
    return null;
  return <TaskRelationsOwner {...props} />;
}

function TaskRelationsOwner(props: Props) {
  const owner = useTaskIdentity();
  return owner.identity &&
    owner.workspace.id === props.record.database.workspaceId ? (
    <TaskRelationsSession
      key={JSON.stringify([
        owner.identity,
        props.record.database.id,
        props.row.row.id,
      ])}
      {...props}
      identity={owner.identity}
    />
  ) : null;
}

function TaskRelationsSession({
  canEdit,
  editorIntent,
  onEditRequest,
  onChanged,
  record,
  row,
  rows,
  identity,
}: Props & { identity: string }) {
  const t = useI18n();
  const navigation = useContext(TaskDetailNavigationContext);
  const canCreate = useLiveData(
    useService(GuardService).can$("Workspace_CreateDoc"),
  );
  const parent = resolveTaskParentProperty(record, row)!;
  const parentRead = useTaskParentRead(record, row);
  const parentCapability =
    !parentRead.loading && !parentRead.error && parentRead.isCurrent()
      ? parentRead.capability
      : undefined;
  const [pageCursors, setPageCursors] = useState<string[]>(() =>
    navigation?.focus?.rowId === row.row.id &&
    !navigation.focus.controlId.startsWith("blocking:")
      ? (navigation.focus.pageCursors ?? [])
      : [],
  );
  const retained = navigation?.creationAttempt?.current;
  const retainedFieldId =
    retained?.owner ===
    taskCreationOwnerKey(identity, record.database.id, row.row.id)
      ? retained.draft.cells.find((cell) => cell.value.relation)?.fieldId
      : undefined;
  const [creationFieldId, setCreationFieldId] = useState<string | undefined>(
    retainedFieldId,
  );
  const [activeEditor, setActiveEditor] = useState<"create" | "parent" | null>(
    retained?.phase !== "confirmed" && retainedFieldId ? "create" : null,
  );
  const showCreate = activeEditor === "create";
  const showParentEditor = activeEditor === "parent";
  // Live reads never replay a consumed opening; the host guards each new intent.
  const consumedIntent = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!editorIntent || consumedIntent.current === editorIntent.sequence)
      return;
    consumedIntent.current = editorIntent.sequence;
    setActiveEditor(
      editorIntent.kind === "create" || editorIntent.kind === "parent"
        ? editorIntent.kind
        : null,
    );
  }, [editorIntent]);
  const registerEditor = navigation?.registerEditor;
  const ownsParentEditor = useRef(false);
  const parentEditSessionChanged = useCallback(
    (session: TaskDetailEditSession | null) => {
      if (session && (session.dirty || session.pending)) {
        ownsParentEditor.current = true;
        registerEditor?.(session);
      } else if (ownsParentEditor.current) {
        ownsParentEditor.current = false;
        registerEditor?.(null);
      }
    },
    [registerEditor],
  );
  useEffect(
    () => () => parentEditSessionChanged(null),
    [parentEditSessionChanged],
  );
  const restoredControl =
    navigation?.focus?.rowId === row.row.id ? navigation.focus : undefined;
  const restoredRowId = restoredControl?.controlId.startsWith("child:")
    ? restoredControl.controlId.slice(6)
    : undefined;
  const [pinnedRowId, setPinnedRowId] = useState<string | undefined>(
    restoredRowId,
  );
  const [confirmedRowId, setConfirmedRowId] = useState<string | undefined>(
    restoredControl?.confirmed ? restoredRowId : undefined,
  );
  const [createdFocus, setCreatedFocus] = useState<string>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef<string | undefined>(undefined);
  const children = useTaskChildren(record, row, pageCursors.at(-1));
  const parentRowId =
    parentCapability?.available &&
    parentCapability.fieldId === parent.field?.id &&
    !parentCapability.diagnostics.length &&
    parentCapability.parentRowIds.length === 1
      ? parentCapability.parentRowIds[0]
      : undefined;
  const summaryRead = useTaskRelationSummaries(
    record,
    children.data?.available && !children.error
      ? [parentRowId, pinnedRowId].filter((id): id is string => Boolean(id))
      : [],
    children.data,
    children.isCurrent,
  );
  const { summaries } = summaryRead;
  const parentSummary = summaries.find((task) => task.rowId === parentRowId);
  const createdSummary = summaries.find((task) => task.rowId === pinnedRowId);
  const editParent = () => {
    if (onEditRequest) {
      onEditRequest("parent");
      return;
    }
    const edit = () => {
      if (!parentRead.isCurrent()) return;
      setActiveEditor("parent");
    };
    if (navigation?.requestLeave) navigation.requestLeave(edit);
    else edit();
  };
  const open = (rowId: string, controlId: string) => {
    if (children.isCurrent())
      navigation?.open(rowId, controlId, pageCursors, rowId === confirmedRowId);
  };
  useEffect(() => {
    const restored = navigation?.focus;
    const intent = createdFocus
      ? { controlId: `child:${createdFocus}`, token: `created:${createdFocus}` }
      : restored?.rowId === row.row.id &&
          !restored.controlId.startsWith("blocking:")
        ? { controlId: restored.controlId, token: `back:${restored.sequence}` }
        : null;
    if (
      !intent ||
      focused.current === intent.token ||
      children.loading ||
      !children.isCurrent()
    )
      return;
    if (intent.controlId === "parent" && !parentCapability) return;
    const target = [
      ...(root.current?.querySelectorAll<HTMLElement>(
        "[data-task-detail-control]",
      ) ?? []),
    ].find((element) => element.dataset.taskDetailControl === intent.controlId);
    if (target && !target.matches(":disabled")) {
      target.focus();
      focused.current = intent.token;
    } else if (
      !summaryRead.loading &&
      (intent.controlId !== "new-subtask" ||
        creationFieldId ||
        children.error ||
        children.data?.available === false)
    ) {
      root.current?.focus();
      focused.current = intent.token;
    }
  }, [
    createdFocus,
    navigation?.focus,
    row.row.id,
    children.loading,
    children.data,
    children.isCurrent,
    summaries,
    summaryRead.loading,
    creationFieldId,
    parentCapability,
  ]);
  const refreshCreated = async (rowId: string) => {
    let failed = false;
    try {
      await onChanged({ kind: "row_created", target: { rowId } });
    } catch {
      failed = true;
    }
    // Inventory/canonical delivery and the child projection are independent
    // reads after the confirmed create; neither failure permits another write.
    await children.read();
    if (children.isCurrent()) setRefreshFailed(failed);
  };
  const created = (task: CreatedTask) => {
    setActiveEditor(null);
    setPinnedRowId(task.rowId);
    setConfirmedRowId(task.rowId);
    setCreatedFocus(undefined);
    setRefreshFailed(false);
    void refreshCreated(task.rowId).then(() => {
      if (children.isCurrent()) setCreatedFocus(task.rowId);
    });
  };
  const fieldId = children.data?.fieldId;
  const page = children.data;
  const parentKnownEmpty = Boolean(
    parentCapability?.available &&
    !parentCapability.diagnostics.length &&
    parentCapability.parentRowIds.length === 0,
  );
  const currentPage = children.pageAfter === pageCursors.at(-1);
  useEffect(() => {
    if (page?.available && page.fieldId) setCreationFieldId(page.fieldId);
  }, [page?.available, page?.fieldId]);
  // Unknown or stale pages retain their native recovery UI, never an empty result.
  if (
    !showCreate &&
    !showParentEditor &&
    page?.available &&
    !children.error &&
    !children.loading &&
    currentPage &&
    children.isCurrent() &&
    page.totalCount === 0 &&
    page.archivedCount === 0 &&
    parentKnownEmpty &&
    !pinnedRowId &&
    !(retained?.phase !== "confirmed" && retainedFieldId)
  )
    return null;
  return (
    <Stack ref={root} tabIndex={-1} data-testid="database-task-relations">
      {showParentEditor || !parentKnownEmpty ? (
        <FormRow label={t["com.myoxus.database.task-parent.label"]()}>
          {showParentEditor && parent.field && !parent.aliased ? (
            <>
              <DatabaseCellEditor
                databaseId={record.database.id}
                field={parent.field}
                record={record}
                row={row}
                rows={rows}
                onChanged={async (change) => {
                  await onChanged(change);
                  if (parentRead.isCurrent()) {
                    setActiveEditor(null);
                    void parentRead.read();
                  }
                }}
                expanded
                readonly={!canEdit || Boolean(row.row.deletedAt)}
                semanticRoleKey="task.parent"
                onEditSessionChange={parentEditSessionChanged}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  if (onEditRequest) {
                    onEditRequest("close");
                    return;
                  }
                  const close = () => {
                    if (parentRead.isCurrent()) setActiveEditor(null);
                  };
                  if (navigation?.requestLeave) navigation.requestLeave(close);
                  else close();
                }}
              >
                {t["com.myoxus.peek-view-controls.close"]()}
              </Button>
            </>
          ) : parentRead.loading ? (
            <Loading />
          ) : parentRead.error || !parentCapability ? (
            <Stack>
              <MyoxusText tone="danger">
                {t["com.myoxus.common.operation-failed"]()}
              </MyoxusText>
              <Button type="button" onClick={() => void parentRead.read()}>
                {t.Retry()}
              </Button>
            </Stack>
          ) : !parentCapability.available ? (
            <MyoxusText tone="secondary">
              {t["com.myoxus.database.task-parent.unavailable"]()}
            </MyoxusText>
          ) : parentCapability.diagnostics.length ? (
            <Stack>
              {parentCapability.diagnostics.map((reason) => (
                <MyoxusText key={reason} tone="secondary">
                  {taskParentReason(t, reason)}
                </MyoxusText>
              ))}
              {canEdit &&
              parent.field &&
              !parent.aliased &&
              !row.row.deletedAt ? (
                <Button type="button" variant="secondary" onClick={editParent}>
                  {t.Edit()}
                </Button>
              ) : null}
            </Stack>
          ) : parentRowId ? (
            <Group>
              {summaryRead.loading ? (
                <Loading />
              ) : parentSummary && navigation && !children.error ? (
                <Button
                  type="button"
                  variant="secondary"
                  data-task-detail-control="parent"
                  onClick={() => open(parentSummary.rowId, "parent")}
                >
                  {parentSummary.title}
                </Button>
              ) : (
                <MyoxusText tone="secondary">
                  {t["com.myoxus.template-list.unavailable"]()}
                </MyoxusText>
              )}
              {canEdit && !row.row.deletedAt ? (
                <Button type="button" variant="secondary" onClick={editParent}>
                  {t.Edit()}
                </Button>
              ) : null}
            </Group>
          ) : null}
        </FormRow>
      ) : null}
      {page?.available && (page.totalCount > 0 || page.archivedCount > 0) ? (
        <MyoxusText>
          {t["com.myoxus.database.task-children.title"]()}
        </MyoxusText>
      ) : null}
      {children.error ? (
        <Stack>
          <MyoxusText tone="danger">
            {t["com.myoxus.common.operation-failed"]()}
          </MyoxusText>
          <Button
            type="button"
            onClick={() => {
              if (children.cursorExpired) setPageCursors([]);
              else void children.read();
            }}
          >
            {t.Retry()}
          </Button>
        </Stack>
      ) : !page ? (
        <Loading />
      ) : !page.available ? (
        <MyoxusText tone="secondary">
          {t["com.myoxus.template-list.unavailable"]()}
        </MyoxusText>
      ) : (
        <>
          {page.totalCount > 0 || page.archivedCount > 0 ? (
            <Group aria-busy={children.loading}>
              {page.totalCount > 0 ? (
                <MyoxusText>
                  {t["com.myoxus.database.task-children.counts"]({
                    complete: page.completeCount.toLocaleString(t.language),
                    total: page.totalCount.toLocaleString(t.language),
                  })}
                </MyoxusText>
              ) : null}
              {page.archivedCount > 0 ? (
                <MyoxusText tone="secondary">
                  {t["com.myoxus.database.task-children.archived"]({
                    count: page.archivedCount.toLocaleString(t.language),
                  })}
                </MyoxusText>
              ) : null}
            </Group>
          ) : null}
          {page.rows.length ? (
            <SurfaceList label={t["com.myoxus.database.task-children.title"]()}>
              {page.rows.map((task) => (
                <SelectableCardRow
                  key={task.rowId}
                  type="button"
                  appearance="row"
                  density="compact"
                  aria-label={task.title}
                  disabled={!navigation || !currentPage}
                  data-task-detail-control={`child:${task.rowId}`}
                  onClick={() => open(task.rowId, `child:${task.rowId}`)}
                >
                  <MyoxusText>{task.title}</MyoxusText>
                </SelectableCardRow>
              ))}
            </SurfaceList>
          ) : null}
          <Group
            role="navigation"
            aria-label={t["com.myoxus.database.task-children.title"]()}
          >
            {pageCursors.length ? (
              <Button
                type="button"
                variant="secondary"
                disabled={children.loading || !currentPage}
                aria-label={t["admin.table.go-prev-page"]()}
                onClick={() =>
                  setPageCursors((current) => current.slice(0, -1))
                }
              >
                {t["common.previous"]()}
              </Button>
            ) : null}
            {page.nextCursor ? (
              <Button
                type="button"
                variant="secondary"
                disabled={children.loading || !currentPage}
                aria-label={t["admin.table.go-next-page"]()}
                onClick={() =>
                  setPageCursors((current) => [...current, page.nextCursor!])
                }
              >
                {t["common.next"]()}
              </Button>
            ) : null}
          </Group>
        </>
      )}
      {pinnedRowId &&
      ((createdSummary && !children.error) || confirmedRowId === pinnedRowId) &&
      (children.error ||
        !page?.rows.some((task) => task.rowId === pinnedRowId)) ? (
        <>
          {!createdSummary || children.error ? (
            <MyoxusText>{pinnedRowId}</MyoxusText>
          ) : null}
          <SelectableCardRow
            type="button"
            appearance="row"
            density="compact"
            aria-label={
              createdSummary && !children.error
                ? createdSummary.title
                : t["com.myoxus.database.tasks.open-task"]()
            }
            disabled={!navigation}
            data-task-detail-control={`child:${pinnedRowId}`}
            onClick={() => open(pinnedRowId, `child:${pinnedRowId}`)}
          >
            <MyoxusText>
              {createdSummary && !children.error
                ? createdSummary.title
                : t["com.myoxus.database.tasks.open-task"]()}
            </MyoxusText>
          </SelectableCardRow>
        </>
      ) : null}
      {refreshFailed ? (
        <Stack>
          <MyoxusText tone="danger">
            {t["com.myoxus.common.operation-failed"]()}
          </MyoxusText>
          <Button
            type="button"
            onClick={() => {
              if (pinnedRowId) void refreshCreated(pinnedRowId);
            }}
          >
            {t.Retry()}
          </Button>
        </Stack>
      ) : null}
      {showCreate &&
      creationFieldId &&
      canEdit &&
      canCreate &&
      !row.row.deletedAt ? (
        <NewSubtask
          databaseId={record.database.id}
          parentRowId={row.row.id}
          fieldId={creationFieldId}
          disabled={
            children.error ||
            !page?.available ||
            fieldId !== creationFieldId ||
            parent.field?.id !== fieldId ||
            parent.aliased
          }
          retention={navigation?.creationAttempt}
          focusRequest={editorIntent?.sequence ?? 0}
          onCancel={() => setActiveEditor(null)}
          onCreated={created}
          onOpen={(task) => open(task.rowId, "new-subtask")}
        />
      ) : null}
    </Stack>
  );
}
