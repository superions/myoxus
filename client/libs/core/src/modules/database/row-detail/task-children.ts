// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  databaseTaskChildrenQuery,
  databaseTaskReferencesQuery,
  DatabaseTaskReferenceState,
  type DatabaseTaskChildrenQuery,
  type DatabaseTaskSummaryFragment,
} from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { waitForTaskReferenceOperation } from "../tasks/task-reference-operation";
import { useTaskFreshness } from "../tasks/use-task-freshness";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";

type Children = NonNullable<
  NonNullable<DatabaseTaskChildrenQuery["workspace"]>["databaseRow"]
>["row"]["taskChildren"];

/** Every page is a current scoped SQL projection. No inventory scan, graph
 * reconstruction or write to the parent's manual progress is involved. */
export function useTaskChildren(
  record: DatabaseRecord,
  row: DatabaseRowRecord,
  after?: string,
) {
  const owner = useTaskIdentity();
  const workspace = useService(WorkspaceService);
  const servers = useService(WorkspaceServerService);
  const alive = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<{
    data?: Children;
    loading: boolean;
    error: boolean;
    cursorExpired?: boolean;
    pageAfter?: string;
  }>({ loading: true, error: false });
  const isCurrent = useCallback(() => {
    const server = servers.server$.value;
    return Boolean(
      alive.current &&
      owner.identity &&
      server &&
      workspace.workspace.id === record.database.workspaceId &&
      JSON.stringify([
        server.id,
        server.baseUrl,
        server.account$.value?.id,
        workspace.workspace.id,
      ]) === owner.identity,
    );
  }, [servers, workspace, owner.identity, record.database.workspaceId]);
  const gql = owner.server?.gql;
  const read = useCallback(async () => {
    if (!gql || !isCurrent()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!navigator.onLine) {
      setState((previous) => ({ ...previous, loading: false, error: true }));
      return;
    }
    setState((previous) => ({
      data: previous.error ? undefined : previous.data,
      pageAfter: previous.pageAfter,
      loading: true,
      error: false,
    }));
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    try {
      const result = await waitForTaskReferenceOperation(
        gql({
          query: databaseTaskChildrenQuery,
          variables: {
            workspaceId: record.database.workspaceId,
            databaseId: record.database.id,
            rowId: row.row.id,
            first: 20,
            after,
          },
          context: { signal },
        }),
        signal,
      );
      if (!isCurrent() || signal.aborted || request.current !== controller)
        return;
      const projected = result.workspace?.databaseRow?.row;
      if (
        result.workspace?.id !== record.database.workspaceId ||
        !projected ||
        projected.id !== row.row.id ||
        projected.databaseId !== record.database.id ||
        !projected.taskChildren ||
        projected.taskChildren.rows.some(
          (task) =>
            task.workspaceId !== record.database.workspaceId ||
            task.databaseId !== record.database.id,
        )
      )
        throw new Error("Children projection unavailable");
      setState({
        data: projected.taskChildren,
        pageAfter: after,
        loading: false,
        error: false,
      });
    } catch (error) {
      const extensions = (
        error as { extensions?: { code?: unknown; data?: { code?: unknown } } }
      )?.extensions;
      const cursorExpired = Boolean(
        after &&
        (extensions?.code ?? extensions?.data?.code) ===
          "MIX_DATABASE_QUERY_INVALID",
      );
      if (
        isCurrent() &&
        !controller.signal.aborted &&
        request.current === controller
      )
        setState((previous) => ({
          ...previous,
          loading: false,
          error: true,
          cursorExpired,
        }));
    }
  }, [
    gql,
    isCurrent,
    record.database.workspaceId,
    record.database.id,
    row.row.id,
    after,
  ]);
  const revision = JSON.stringify([
    record.database.editRevision,
    record.fieldRoles,
    record.fields.map((field) => [field.id, field.editRevision]),
    row.row.editRevision,
    row.cellRevisions,
  ]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    void read();
    return () => request.current?.abort();
  }, [read, revision]);
  useEffect(() => {
    const offline = () => {
      request.current?.abort();
      if (isCurrent())
        setState((previous) => ({ ...previous, loading: false, error: true }));
    };
    const online = () => void read();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [isCurrent, read]);
  useTaskFreshness(owner, read);
  return { ...state, read, isCurrent };
}

/** Parent and newly-created controls get current authorized summaries, never
 * titles from a retained Cell or a creation draft. The per-opening state clears
 * on failed reads, offline, changed identity or changed target IDs. */
export function useTaskRelationSummaries(
  record: DatabaseRecord,
  rowIds: string[],
  revision: unknown,
  isCurrent: () => boolean,
) {
  const owner = useTaskIdentity();
  const ids = JSON.stringify([...new Set(rowIds)].sort());
  const gql = owner.server?.gql;
  const readKey = useMemo(
    () => ({}),
    [
      ids,
      revision,
      owner.identity,
      gql,
      record.database.id,
      record.database.workspaceId,
    ],
  );
  const [state, setState] = useState<{
    key: object;
    rows: DatabaseTaskSummaryFragment[];
    loading: boolean;
  }>({ key: readKey, rows: [], loading: true });
  useEffect(() => {
    setState({ key: readKey, rows: [], loading: false });
    if (!gql || !isCurrent() || !navigator.onLine) return;
    const targets = (JSON.parse(ids) as string[]).map((rowId) => ({
      workspaceId: record.database.workspaceId,
      databaseId: record.database.id,
      rowId,
    }));
    if (!targets.length) return;
    setState({ key: readKey, rows: [], loading: true });
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    void waitForTaskReferenceOperation(
      gql({
        query: databaseTaskReferencesQuery,
        variables: { workspaceId: record.database.workspaceId, targets },
        context: { signal },
      }),
      signal,
    )
      .then((result) => {
        if (!isCurrent() || signal.aborted) return;
        const projections = result.workspace?.databaseTaskReferences;
        if (
          result.workspace?.id !== record.database.workspaceId ||
          !projections ||
          projections.length !== targets.length
        )
          throw new Error("Task summary unavailable");
        const valid: DatabaseTaskSummaryFragment[] = [];
        for (let index = 0; index < targets.length; index++) {
          const target = targets[index];
          const projection = projections[index];
          if (
            projection.workspaceId !== target.workspaceId ||
            projection.databaseId !== target.databaseId ||
            projection.rowId !== target.rowId
          )
            throw new Error("Task summary identity mismatch");
          const task = projection.task;
          if (
            projection.state === DatabaseTaskReferenceState.Available &&
            task &&
            task.workspaceId === target.workspaceId &&
            task.databaseId === target.databaseId &&
            task.rowId === target.rowId
          )
            valid.push(task);
        }
        setState({ key: readKey, rows: valid, loading: false });
      })
      .catch(() => {
        if (isCurrent() && !controller.signal.aborted)
          setState({ key: readKey, rows: [], loading: false });
      });
    const offline = () => {
      controller.abort();
      setState({ key: readKey, rows: [], loading: false });
    };
    window.addEventListener("offline", offline);
    return () => {
      controller.abort();
      window.removeEventListener("offline", offline);
    };
  }, [
    gql,
    owner.identity,
    record.database.id,
    record.database.workspaceId,
    ids,
    revision,
    isCurrent,
    readKey,
  ]);
  return {
    summaries: state.key === readKey ? state.rows : [],
    loading: state.key !== readKey || state.loading,
  };
}
