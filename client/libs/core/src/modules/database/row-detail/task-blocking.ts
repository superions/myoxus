// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  databaseTaskBlockedByQuery,
  databaseTaskBlocksQuery,
} from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { useCallback, useEffect, useRef, useState } from "react";

import type { BlockedByCapability } from "../relation/task-blocked-by-editor";
import { waitForTaskReferenceOperation } from "../tasks/task-reference-operation";
import { useTaskFreshness } from "../tasks/use-task-freshness";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";

export type TaskBlockingPage = Pick<
  BlockedByCapability,
  "available" | "fieldId" | "diagnostics" | "rows" | "nextCursor"
>;

/** One authorized native outgoing or inverse page for the read-only section.
 * The explicit picker keeps its own current Cell-edit admission. */
export function useTaskBlockingRead(
  record: DatabaseRecord,
  row: DatabaseRowRecord,
  direction: "blockedBy" | "blocks",
  after?: string,
) {
  const owner = useTaskIdentity();
  const servers = useService(WorkspaceServerService);
  const workspace = useService(WorkspaceService);
  const alive = useRef(true);
  const request = useRef<AbortController | undefined>(undefined);
  const [state, setState] = useState<{
    data?: TaskBlockingPage;
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
  }, [servers, workspace, record.database.workspaceId, owner.identity]);
  const gql = owner.server?.gql;
  const read = useCallback(async () => {
    if (!gql || !isCurrent()) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!navigator.onLine) {
      setState({ loading: false, error: true });
      return;
    }
    setState((previous) => ({ ...previous, loading: true, error: false }));
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    try {
      const variables = {
        workspaceId: record.database.workspaceId,
        databaseId: record.database.id,
        rowId: row.row.id,
        after,
      };
      const result = await waitForTaskReferenceOperation<{
        workspaceId?: string;
        rowId?: string;
        databaseId?: string;
        page?: TaskBlockingPage;
      }>(
        direction === "blocks"
          ? gql({
              query: databaseTaskBlocksQuery,
              variables,
              context: { signal },
            }).then((response) => ({
              workspaceId: response.workspace?.id,
              rowId: response.workspace?.databaseRow?.row.id,
              databaseId: response.workspace?.databaseRow?.row.databaseId,
              page: response.workspace?.databaseRow?.row.taskBlocks,
            }))
          : gql({
              query: databaseTaskBlockedByQuery,
              variables,
              context: { signal },
            }).then((response) => ({
              workspaceId: response.workspace?.id,
              rowId: response.workspace?.databaseRow?.row.id,
              databaseId: response.workspace?.databaseRow?.row.databaseId,
              page: response.workspace?.databaseRow?.row.taskBlockedBy,
            })),
        signal,
      );
      if (!isCurrent() || signal.aborted || request.current !== controller)
        return;
      const page = result.page;
      if (
        result.workspaceId !== record.database.workspaceId ||
        result.rowId !== row.row.id ||
        result.databaseId !== record.database.id ||
        !page ||
        page.rows.some(
          (entry) =>
            entry.task &&
            (entry.task.workspaceId !== record.database.workspaceId ||
              entry.task.databaseId !== record.database.id ||
              entry.task.rowId !== entry.rowId),
        ) ||
        (page.nextCursor && (page.nextCursor === after || !page.rows.length))
      )
        throw new Error("Blocking projection unavailable");
      setState({ data: page, pageAfter: after, loading: false, error: false });
    } catch (error) {
      if (
        isCurrent() &&
        !controller.signal.aborted &&
        request.current === controller
      ) {
        const extensions = (
          error as { extensions?: { code?: string; data?: { code?: string } } }
        )?.extensions;
        setState({
          loading: false,
          error: true,
          cursorExpired: Boolean(
            after &&
            (extensions?.code ?? extensions?.data?.code) ===
              "MIX_DATABASE_QUERY_INVALID",
          ),
        });
      }
    }
  }, [
    gql,
    isCurrent,
    record.database.workspaceId,
    record.database.id,
    row.row.id,
    direction,
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
      if (isCurrent()) setState({ loading: false, error: true });
    };
    const online = () => void read();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [read, isCurrent]);
  useTaskFreshness(owner, read);
  return { ...state, read, isCurrent };
}
