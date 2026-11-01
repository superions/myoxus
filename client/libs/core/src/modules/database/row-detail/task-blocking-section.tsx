// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseTaskBlockingState } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
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
import { taskBlockedByReason } from "../relation/task-blocked-by-reason";
import type { DatabaseChangeHandler } from "../shared";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import { resolveTaskBlockedByProperty } from "./field-role-resolver";
import { type TaskBlockingPage, useTaskBlockingRead } from "./task-blocking";
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

export function DatabaseTaskBlockingSection(props: Props) {
  if (
    props.row.redacted ||
    !resolveTaskBlockedByProperty(props.record, props.row)
  )
    return null;
  return <BlockingOwner {...props} />;
}

function BlockingOwner(props: Props) {
  const owner = useTaskIdentity();
  if (
    !owner.identity ||
    owner.workspace.id !== props.record.database.workspaceId
  )
    return null;
  return (
    <BlockingSession
      key={JSON.stringify([
        owner.identity,
        props.record.database.id,
        props.row.row.id,
      ])}
      {...props}
    />
  );
}

function BlockingSession({
  record,
  row,
  rows,
  canEdit,
  onChanged,
  editorIntent,
  onEditRequest,
}: Props) {
  const t = useI18n();
  const navigation = useContext(TaskDetailNavigationContext);
  const property = resolveTaskBlockedByProperty(record, row)!;
  const [editing, setEditing] = useState(false);
  const consumedIntent = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!editorIntent || consumedIntent.current === editorIntent.sequence)
      return;
    consumedIntent.current = editorIntent.sequence;
    setEditing(editorIntent.kind === "blockedBy");
  }, [editorIntent]);
  const registerEditor = navigation?.registerEditor;
  const ownsEditor = useRef(false);
  const editSessionChanged = useCallback(
    (session: TaskDetailEditSession | null) => {
      if (session && (session.dirty || session.pending)) {
        ownsEditor.current = true;
        registerEditor?.(session);
      } else if (ownsEditor.current) {
        ownsEditor.current = false;
        registerEditor?.(null);
      }
    },
    [registerEditor],
  );
  useEffect(() => () => editSessionChanged(null), [editSessionChanged]);
  const requestEdit = (kind: "blockedBy" | "close") => {
    if (onEditRequest) {
      onEditRequest(kind);
      return;
    }
    const next = () => {
      if (outgoing.isCurrent()) setEditing(kind === "blockedBy");
    };
    if (navigation?.requestLeave) navigation.requestLeave(next);
    else next();
  };
  const restored =
    navigation?.focus?.rowId === row.row.id ? navigation.focus : undefined;
  const [cursors, setCursors] = useState<string[]>(() =>
    restored?.controlId.startsWith("blocking:blocks:")
      ? (restored.pageCursors ?? [])
      : [],
  );
  const [outgoingCursors, setOutgoingCursors] = useState<string[]>(() =>
    restored?.controlId.startsWith("blocking:blockedBy:")
      ? (restored.pageCursors ?? [])
      : [],
  );
  const outgoing = useTaskBlockingRead(
    record,
    row,
    "blockedBy",
    outgoingCursors.at(-1),
  );
  const inverse = useTaskBlockingRead(record, row, "blocks", cursors.at(-1));
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef<number | undefined>(undefined);
  const inverseLoading = inverse.loading;
  const outgoingLoading = outgoing.loading;
  const isInverseCurrent = inverse.isCurrent;
  useEffect(() => {
    if (
      !restored?.controlId.startsWith("blocking:") ||
      focused.current === restored.sequence ||
      !isInverseCurrent()
    )
      return;
    if (
      restored.controlId.startsWith("blocking:blocks:")
        ? inverseLoading
        : outgoingLoading
    )
      return;
    const target = [
      ...(root.current?.querySelectorAll<HTMLElement>(
        "[data-task-detail-control]",
      ) ?? []),
    ].find((node) => node.dataset.taskDetailControl === restored.controlId);
    if (target && !target.matches(":disabled")) target.focus();
    else root.current?.focus();
    focused.current = restored.sequence;
  }, [
    restored,
    inverseLoading,
    isInverseCurrent,
    outgoingLoading,
    outgoing.data,
  ]);
  const entries = (
    page: TaskBlockingPage,
    direction: "blockedBy" | "blocks",
    loading: boolean,
  ) => (
    <SurfaceList
      label={
        direction === "blockedBy"
          ? t["com.myoxus.database.task-blocking.blocked-by"]()
          : t["com.myoxus.database.task-blocking.blocks"]()
      }
    >
      {[
        ...new Map(page.rows.map((entry) => [entry.rowId, entry])).values(),
      ].map((entry) => {
        const task = entry.task;
        const authorized =
          task?.workspaceId === record.database.workspaceId &&
          task.databaseId === record.database.id &&
          task.rowId === entry.rowId;
        const title = authorized
          ? task.title
          : t["com.myoxus.template-list.unavailable"]();
        const control = `blocking:${direction}:${entry.rowId}`;
        return (
          <SelectableCardRow
            key={entry.rowId}
            type="button"
            appearance="row"
            density="compact"
            aria-label={title}
            title={title}
            data-task-detail-control={control}
            disabled={
              !authorized || !navigation || loading || !inverse.isCurrent()
            }
            onClick={() => {
              if (inverse.isCurrent())
                navigation?.open(
                  entry.rowId,
                  control,
                  direction === "blocks" ? cursors : outgoingCursors,
                );
            }}
          >
            <Stack>
              <MyoxusText>{title}</MyoxusText>
              <Badge
                tone={
                  entry.state === DatabaseTaskBlockingState.Unavailable
                    ? "warning"
                    : "neutral"
                }
              >
                {entry.state === DatabaseTaskBlockingState.Active
                  ? t["com.myoxus.database.task-blocking.active"]()
                  : entry.state === DatabaseTaskBlockingState.Inactive
                    ? t["com.myoxus.database.task-blocking.inactive"]()
                    : t["com.myoxus.database.task-blocking.unresolved"]()}
              </Badge>
            </Stack>
          </SelectableCardRow>
        );
      })}
    </SurfaceList>
  );
  const renderPage = (direction: "blockedBy" | "blocks") => {
    const read = direction === "blocks" ? inverse : outgoing;
    const history = direction === "blocks" ? cursors : outgoingCursors;
    const setHistory = direction === "blocks" ? setCursors : setOutgoingCursors;
    const page = read.data;
    const currentPage = read.pageAfter === history.at(-1);
    const repeatedCursor = Boolean(
      page?.nextCursor && history.includes(page.nextCursor),
    );
    const label =
      direction === "blocks"
        ? t["com.myoxus.database.task-blocking.blocks"]()
        : t["com.myoxus.database.task-blocking.blocked-by"]();
    const invalidField = Boolean(
      page?.available &&
      (page.fieldId !== property.field?.id || property.aliased),
    );
    if (
      !read.error &&
      !read.loading &&
      page?.available &&
      !invalidField &&
      !page.diagnostics.length &&
      !page.rows.length &&
      !page.nextCursor &&
      !history.length &&
      currentPage
    )
      return null;
    return (
      <Stack>
        <MyoxusText>{label}</MyoxusText>
        {read.error || repeatedCursor ? (
          <Stack>
            <MyoxusText tone="danger">
              {t["com.myoxus.common.operation-failed"]()}
            </MyoxusText>
            <Button
              type="button"
              onClick={() => {
                if (read.cursorExpired || repeatedCursor) setHistory([]);
                else void read.read();
              }}
            >
              {t.Retry()}
            </Button>
          </Stack>
        ) : !page ? (
          <Loading />
        ) : !page.available || invalidField ? (
          <MyoxusText tone="secondary">
            {taskBlockedByReason(
              t,
              page.diagnostics[0] ?? "IncompatibleRoleConfiguration",
            )}
          </MyoxusText>
        ) : (
          <>
            {read.loading ? <Loading /> : null}
            {page.diagnostics.map((reason) => (
              <MyoxusText key={reason} tone="secondary">
                {taskBlockedByReason(t, reason)}
              </MyoxusText>
            ))}
            {page.rows.length
              ? entries(page, direction, read.loading || !currentPage)
              : null}
            {history.length || page.nextCursor ? (
              <Group role="navigation" aria-label={label}>
                {history.length ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={read.loading || !currentPage}
                    aria-label={t["admin.table.go-prev-page"]()}
                    onClick={() =>
                      setHistory((current) => current.slice(0, -1))
                    }
                  >
                    {t["common.previous"]()}
                  </Button>
                ) : null}
                {page.nextCursor ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={read.loading || !currentPage}
                    aria-label={t["admin.table.go-next-page"]()}
                    onClick={() =>
                      setHistory((current) => [...current, page.nextCursor!])
                    }
                  >
                    {t["common.next"]()}
                  </Button>
                ) : null}
              </Group>
            ) : null}
          </>
        )}
      </Stack>
    );
  };
  const empty = (read: typeof outgoing, history: string[]) =>
    read.isCurrent() &&
    !read.error &&
    !read.loading &&
    read.data?.available &&
    read.data.fieldId === property.field?.id &&
    !property.aliased &&
    !read.data.diagnostics.length &&
    !read.data.rows.length &&
    !read.data.nextCursor &&
    !history.length &&
    read.pageAfter === history.at(-1);
  if (
    !editing &&
    empty(outgoing, outgoingCursors) &&
    empty(inverse, cursors) &&
    !restored?.controlId.startsWith("blocking:")
  )
    return null;
  return (
    <Stack ref={root} tabIndex={-1} data-testid="database-task-blocking">
      {editing && property.field && !property.aliased ? (
        <FormRow label={t["com.myoxus.database.task-blocking.blocked-by"]()}>
          <DatabaseCellEditor
            databaseId={record.database.id}
            field={property.field}
            record={record}
            row={row}
            rows={rows}
            expanded
            readonly={!canEdit || Boolean(row.row.deletedAt)}
            semanticRoleKey="task.blockedBy"
            onEditSessionChange={editSessionChanged}
            onChanged={async (change) => {
              await onChanged(change);
              if (outgoing.isCurrent()) {
                setEditing(false);
                void outgoing.read();
                void inverse.read();
              }
            }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => requestEdit("close")}
          >
            {t["com.myoxus.peek-view-controls.close"]()}
          </Button>
        </FormRow>
      ) : (
        <>
          {renderPage("blockedBy")}
          {canEdit &&
          !row.row.deletedAt &&
          property.field &&
          !property.aliased &&
          (outgoing.data?.rows.length || outgoing.data?.diagnostics.length) ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => requestEdit("blockedBy")}
            >
              {t.Edit()}
            </Button>
          ) : null}
        </>
      )}
      {renderPage("blocks")}
    </Stack>
  );
}
