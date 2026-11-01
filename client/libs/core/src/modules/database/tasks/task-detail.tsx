// SPDX-License-Identifier: AGPL-3.0-or-later

import { databaseManagedCapabilities, managedTaskFields } from "../managed";
import { managedTaskUnavailableLabel } from "./managed-feedback";

import {
  useMutation,
  useMutateQueryResource,
} from "@myoxus/core/components/hooks/use-mutation";
import { GuardService } from "@myoxus/core/modules/permissions";
import {
  databaseSchemaQuery,
  databaseViewsQuery,
  databaseRowQuery,
  bulkRestoreDatabaseRowsMutation,
  DatabaseProfileKind,
  DatabaseTaskReferenceState,
  databaseTaskReferencesQuery,
  databaseRowActivityQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  EmptyState,
  Loading,
  Notice,
  MenuItem,
  Scrollable,
  WorkbenchContextScrollRoot,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useRef, useState } from "react";
import useSWR, { SWRConfig } from "swr";

import {
  DatabaseConflictProvider,
  DatabasePresenceProvider,
  useDatabaseConflictController,
  useDatabasePresence,
  useDatabaseSocket,
} from "../presence";
import {
  DatabaseResolvedRowDetailPeekBody,
  DatabaseRowActionMenu,
  useDeleteDatabaseRowAction,
} from "../row-detail";
import { useDatabaseCurrentRead } from "../shared/use-current-read";
import { classifyDatabaseError } from "../route-state";
import type { DatabaseChangeHandler } from "../shared";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import { inflateDatabaseViewSummary } from "../model";
import { useTaskIdentity } from "./use-workspace-tasks";
import { useTaskFreshness } from "./use-task-freshness";

/** Load the canonical Row independently of inventory membership. The host keys
 * this boundary by server/account/workspace/Database/Row, so selected drafts
 * and delayed completions cannot be adopted by a different Task.
 */
export function TaskDetail({
  databaseId,
  rowId,
  onChanged,
  onOpenDoc,
  onOpenProject,
  focusDue,
  onDueFocused,
}: {
  databaseId: string;
  rowId: string;
  focusDue?: number;
  onDueFocused?: (request: number) => void;
  onChanged: DatabaseChangeHandler;
  onOpenDoc: (docId: string) => void;
  onOpenProject: (databaseId: string) => void;
}) {
  const t = useI18n();
  // Native Row children use the existing query/variables keys. Their cache
  // shares this selected Task's keyed identity lifetime, never another actor.
  const nativeQueries = useMemo(() => ({ provider: () => new Map() }), []);
  const owner = useTaskIdentity();
  const { server, account, workspace, availability, identity } = owner;
  const admissionKey = JSON.stringify([identity, databaseId, rowId]);
  const fetchCurrent = async (signal?: AbortSignal) => {
    const references = await server!.gql({
      query: databaseTaskReferencesQuery,
      context: { signal },
      variables: {
        workspaceId: workspace.id,
        targets: [{ workspaceId: workspace.id, databaseId, rowId }],
      },
    });
    const reference = references.workspace?.databaseTaskReferences[0];
    if (
      (reference?.state !== DatabaseTaskReferenceState.Available &&
        reference?.state !== DatabaseTaskReferenceState.Trashed) ||
      !reference.task ||
      reference.workspaceId !== workspace.id ||
      reference.rowId !== rowId ||
      reference.task.workspaceId !== workspace.id ||
      reference.task.rowId !== rowId ||
      reference.databaseId !== reference.task.databaseId
    )
      return { record: null, row: null };
    const variables = {
      workspaceId: workspace.id,
      databaseId: reference.task.databaseId,
    };
    const [database, views, row] = await Promise.all([
      server!.gql({
        query: databaseSchemaQuery,
        variables,
        context: { signal },
      }),
      server!.gql({
        query: databaseViewsQuery,
        variables,
        context: { signal },
      }),
      server!.gql({
        query: databaseRowQuery,
        context: { signal },
        variables: { ...variables, rowId, includeTrashed: true },
      }),
    ]);
    return {
      record:
        database.workspace?.database && views.workspace?.database
          ? {
              ...database.workspace.database,
              views: views.workspace.database.views.map(
                inflateDatabaseViewSummary,
              ),
            }
          : null,
      row: row.workspace?.databaseRow,
    };
  };
  const read = useSWR(
    availability.status === "available" && server && account
      ? ["task-canonical-detail", identity, databaseId, rowId]
      : null,
    () => fetchCurrent(),
    {
      suspense: false,
      suppressErrorNotification: true,
      keepPreviousData: false,
      revalidateOnFocus: false,
      revalidateOnMount: false,
      revalidateOnReconnect: false,
    },
  );
  const currentRead = useDatabaseCurrentRead(
    admissionKey,
    availability.status === "available" && Boolean(server && account),
    fetchCurrent,
    read,
  );
  useTaskFreshness(owner, async () => {
    if (!(await currentRead.reload()))
      throw new Error("Task current read unavailable");
  });
  const reloadCurrent = currentRead.reload;
  const refresh = useCallback<DatabaseChangeHandler>(
    async (reason) => {
      await reloadCurrent();
      await onChanged(reason);
    },
    [reloadCurrent, onChanged],
  );
  const record = read.data?.record;
  const row = read.data?.row;
  const failure = currentRead.error
    ? classifyDatabaseError(currentRead.error)
    : null;
  const invalidated = failure === "forbidden" || failure === "missing";
  const valid =
    currentRead.admitted &&
    !invalidated &&
    record?.database.profileKind === DatabaseProfileKind.Project &&
    databaseManagedCapabilities(record).ready &&
    !record.database.deletedAt &&
    row?.row.rowKind === "task" &&
    !row.redacted &&
    row.row.databaseId === record.database.id;
  const viewport = useRef<HTMLDivElement>(null);
  const focusedDue = useRef<number | undefined>(undefined);
  const focusDueEditor = useCallback(() => {
    if (
      !focusDue ||
      focusedDue.current === focusDue ||
      !valid ||
      read.isLoading
    )
      return;
    const field = managedTaskFields(record)?.get("task.dueDate");
    if (!field) return;
    const input = Array.from(
      viewport.current?.querySelectorAll<HTMLElement>(
        "[data-database-field-id]",
      ) ?? [],
    ).find((input) => input.dataset.databaseFieldId === field.id);
    if (!input) return;
    // The inventory action only selects the canonical editor; it never writes
    // a due value or a personal reminder from summary data.
    focusedDue.current = focusDue;
    input.scrollIntoView({ block: "nearest" });
    input.focus();
    onDueFocused?.(focusDue);
  }, [focusDue, valid, read.isLoading, record, onDueFocused]);
  return (
    <WorkbenchContextScrollRoot>
      <Scrollable.Viewport ref={viewport} scrollbars="y">
        {read.isLoading || (!currentRead.admitted && !currentRead.error) ? (
          <Loading />
        ) : !valid ? (
          <EmptyState
            title={
              record && !databaseManagedCapabilities(record).ready
                ? managedTaskUnavailableLabel(
                    t,
                    record.managedSchema?.reasonCode,
                  )
                : currentRead.error &&
                    classifyDatabaseError(currentRead.error) === "forbidden"
                  ? t["com.myoxus.database.row_detail.forbidden"]()
                  : currentRead.error
                    ? t["com.myoxus.database.row_detail.unavailable"]()
                    : t["com.myoxus.database.row_detail.missing"]()
            }
            cta={
              currentRead.error || record ? (
                <Button onClick={() => void currentRead.reload()}>
                  {t.Retry()}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <SWRConfig value={nativeQueries}>
            <DatabaseConflictProvider>
              {currentRead.error ? (
                <Notice
                  tone="warning"
                  title={t["com.myoxus.database.row_detail.unavailable"]()}
                >
                  <Button onClick={() => void currentRead.reload()}>
                    {t.Retry()}
                  </Button>
                </Notice>
              ) : null}
              <ResolvedTaskDetail
                databaseId={record!.database.id}
                record={record!}
                row={row!}
                workspaceId={workspace.id}
                onChanged={refresh}
                onOpenDoc={onOpenDoc}
                onOpenProject={onOpenProject}
                onPresentationReady={focusDueEditor}
                focusDue={focusDue}
              />
            </DatabaseConflictProvider>
          </SWRConfig>
        )}
      </Scrollable.Viewport>
      <Scrollable.Scrollbar />
    </WorkbenchContextScrollRoot>
  );
}

function ResolvedTaskDetail({
  databaseId,
  record,
  row,
  workspaceId,
  onChanged,
  onOpenDoc,
  onOpenProject,
  onPresentationReady,
  focusDue,
}: {
  databaseId: string;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  workspaceId: string;
  onChanged: DatabaseChangeHandler;
  onOpenDoc: (docId: string) => void;
  onOpenProject: (databaseId: string) => void;
  onPresentationReady: () => void;
  focusDue?: number;
}) {
  const t = useI18n();
  const { server } = useTaskIdentity();
  const canWrite = useLiveData(
    useService(GuardService).can$("Workspace_CreateDoc"),
  );
  const conflicts = useDatabaseConflictController();
  const revalidate = useMutateQueryResource();
  const changed = useCallback<DatabaseChangeHandler>(
    async (reason) => {
      await onChanged(reason);
      // Activity is best-effort: its own query renders failure, while a
      // committed Cell/Row mutation must not become a failed editable intent.
      try {
        await revalidate(
          databaseRowActivityQuery,
          (vars) =>
            vars.workspaceId === workspaceId && vars.rowId === row.row.id,
        );
      } catch {
        // The Activity query presents its read failure independently.
      }
    },
    [onChanged, revalidate, workspaceId, row.row.id],
  );
  const restore = useMutation({ mutation: bulkRestoreDatabaseRowsMutation });
  const socket = useDatabaseSocket();
  const presence = useDatabasePresence({
    socket,
    workspaceId,
    databaseId,
    publishLocal: Boolean(canWrite && !row.row.deletedAt),
    onChange: () => {
      void changed();
    },
  });
  const deleteRow = useDeleteDatabaseRowAction(databaseId, changed);
  const deleting = useRef(false);
  const [actionFailed, setActionFailed] = useState(false);
  const restoring = useRef(false);
  const [restorePending, setRestorePending] = useState(false);
  const trashRow = async () => {
    if (deleting.current) return;
    deleting.current = true;
    setActionFailed(false);
    try {
      await deleteRow(row);
    } catch {
      setActionFailed(true);
    } finally {
      deleting.current = false;
    }
  };
  const restoreRow = async () => {
    if (restoring.current) return;
    restoring.current = true;
    setRestorePending(true);
    setActionFailed(false);
    try {
      await conflicts.execute({
        attemptedAction: t["com.myoxus.database.bulk.action.restore"](),
        localValue: row.row.title,
        mutate: async (force) => {
          const response = await restore.trigger({
            input: {
              databaseId,
              rowIds: [row.row.id],
              force,
              expectedEditRevisions: [
                {
                  rowId: row.row.id,
                  expectedEditRevision: row.row.editRevision,
                },
              ],
            },
          });
          const result = response.bulkRestoreDatabaseRows;
          if (
            result.transactionCommitted &&
            result.failureCount === 0 &&
            result.succeeded.includes(row.row.id)
          )
            return response;
          // Bulk diagnostics can report a stale Row as a normal GraphQL result.
          // Only the matching committed success may advance the detail state.
          const failure = result.failed.find(
            (item) => item.rowId === row.row.id,
          );
          if (
            failure?.errorCode === "MIX_DATABASE_CONFLICT" ||
            failure?.errorCode === "MIX_DATABASE_ROW_CONFLICT"
          ) {
            throw { extensions: { code: "MIX_DATABASE_ROW_CONFLICT" } };
          }
          throw new Error("Task restore was not confirmed");
        },
        readServerValue: async () => {
          const response = await server!.gql({
            query: databaseRowQuery,
            variables: {
              workspaceId,
              databaseId,
              rowId: row.row.id,
              includeTrashed: true,
            },
          });
          return response.workspace?.databaseRow?.row.title ?? null;
        },
        reloadLatest: () => changed(),
        afterSuccess: () =>
          changed({ kind: "row_restored", target: { rowId: row.row.id } }),
      });
    } catch {
      setActionFailed(true);
    } finally {
      restoring.current = false;
      setRestorePending(false);
    }
  };
  const viewId = record.views[0]?.id ?? "";
  const canEdit = Boolean(canWrite && !row.row.deletedAt);
  return (
    <DatabasePresenceProvider value={presence}>
      {actionFailed ? (
        <Notice
          tone="error"
          title={t["com.myoxus.common.operation-failed"]()}
        />
      ) : null}
      <DatabaseResolvedRowDetailPeekBody
        headerActions={
          <DatabaseRowActionMenu
            row={row}
            record={record}
            onChanged={changed}
            canEdit={canEdit}
            showOpenDetails={false}
            onDelete={canEdit ? () => void trashRow() : undefined}
            additionalItems={
              !databaseManagedCapabilities(record).workspaceTasks ? (
                <MenuItem onSelect={() => onOpenProject(record.database.id)}>
                  {t["com.myoxus.database.tasks.open-project"]()}
                </MenuItem>
              ) : null
            }
          />
        }
        restoreAction={
          canWrite && row.row.deletedAt ? (
            <Button
              variant="primary"
              disabled={restorePending}
              onClick={() => void restoreRow()}
            >
              {t["com.myoxus.database.bulk.action.restore"]()}
            </Button>
          ) : null
        }
        canEdit={canEdit}
        databaseId={databaseId}
        onChanged={changed}
        onOpenDoc={onOpenDoc}
        onPresentationReady={onPresentationReady}
        focusDue={focusDue}
        record={record}
        row={row}
        rows={[row]}
        viewId={viewId}
        workspaceId={workspaceId}
      />
    </DatabasePresenceProvider>
  );
}
