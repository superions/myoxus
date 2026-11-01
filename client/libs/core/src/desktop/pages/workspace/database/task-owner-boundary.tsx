// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTaskIdentity } from "@myoxus/core/modules/database/tasks/use-workspace-tasks";
import { useTaskFreshness } from "@myoxus/core/modules/database/tasks/use-task-freshness";
import { classifyDatabaseError } from "@myoxus/core/modules/database/route-state";
import { useDatabaseCurrentRead } from "@myoxus/core/modules/database/shared/use-current-read";
import { ViewService } from "@myoxus/core/modules/workbench";
import {
  databaseSchemaQuery,
  databaseRowQuery,
  databaseTaskReferencesQuery,
  DatabaseProfileKind,
  DatabaseTaskReferenceState,
} from "@myoxus/graphql";
import { useService } from "@myoxus/infra";
import { useEffect, useRef, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import useSWR from "swr";

/** A stored Task link keeps its Row UUID while the Database ID is only a hint.
 * Generic and non-Task managed Row links retain their native route after an
 * explicit authorized classification;
 * an unavailable managed Task never falls back to cached source Row content.
 */
export function DatabaseTaskOwnerBoundary({
  children,
  renderState,
}: {
  children: ReactNode | ((ownerAdmissionPending: boolean) => ReactNode);
  renderState: (
    state: "loading" | "forbidden" | "unavailable",
    retry: () => void,
  ) => ReactNode;
}) {
  const owner = useTaskIdentity();
  const { databaseId } = useParams<{ databaseId: string }>();
  const [params] = useSearchParams();
  const rowId = params.get("rowId");
  const view = useService(ViewService).view;
  const enabled = Boolean(
    rowId &&
    databaseId &&
    owner.identity &&
    owner.server &&
    owner.availability.status === "available",
  );
  const admissionKey = JSON.stringify([owner.identity, databaseId, rowId]);
  const fetchCurrent = async (signal?: AbortSignal) => {
    const target = {
      workspaceId: owner.workspace.id,
      databaseId: databaseId!,
      rowId: rowId!,
    };
    const response = await owner.server!.gql({
      query: databaseTaskReferencesQuery,
      context: { signal },
      variables: { workspaceId: owner.workspace.id, targets: [target] },
    });
    const reference = response.workspace?.databaseTaskReferences[0];
    if (
      !reference ||
      reference.workspaceId !== target.workspaceId ||
      reference.rowId !== target.rowId
    )
      return { kind: "unavailable" as const };
    if (
      reference.task &&
      (reference.state === DatabaseTaskReferenceState.Available ||
        reference.state === DatabaseTaskReferenceState.Trashed) &&
      reference.task.workspaceId === target.workspaceId &&
      reference.task.rowId === target.rowId &&
      reference.databaseId === reference.task.databaseId
    )
      return { kind: "task" as const, databaseId: reference.task.databaseId };
    // Non-Task Generic Rows are not admitted by the Task projection. A fresh
    // authorized Generic schema read distinguishes them from denied Task links.
    const schema = await owner.server!.gql({
      query: databaseSchemaQuery,
      context: { signal },
      variables: { workspaceId: owner.workspace.id, databaseId: databaseId! },
    });
    const database = schema.workspace?.database?.database;
    if (
      !database ||
      database.id !== databaseId ||
      database.workspaceId !== owner.workspace.id
    )
      return { kind: "unavailable" as const };
    if (database.profileKind === DatabaseProfileKind.Generic)
      return { kind: "native" as const };
    // Phase/Milestone detail links share this route, but are not Task references.
    // Only a fresh non-Task Row classification admits their native host.
    const native = await owner.server!.gql({
      query: databaseRowQuery,
      context: { signal },
      variables: {
        workspaceId: owner.workspace.id,
        databaseId: databaseId!,
        rowId: rowId!,
        includeTrashed: true,
      },
    });
    const row = native.workspace?.databaseRow;
    return row &&
      !row.redacted &&
      row.row.databaseId === databaseId &&
      row.row.id === rowId &&
      row.row.rowKind !== "task"
      ? { kind: "native" as const }
      : { kind: "unavailable" as const };
  };
  const read = useSWR(
    enabled ? ["database-task-owner", owner.identity, databaseId, rowId] : null,
    () => fetchCurrent(),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
      revalidateOnMount: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );
  const currentRead = useDatabaseCurrentRead(
    admissionKey,
    enabled,
    fetchCurrent,
    read,
  );
  useTaskFreshness(
    {
      ...owner,
      identity:
        enabled && currentRead.admitted && read.data?.kind === "task"
          ? owner.identity
          : null,
    },
    async () => {
      if (!(await currentRead.reload()))
        throw new Error("Task owner read unavailable");
    },
  );
  const failure = currentRead.error
    ? classifyDatabaseError(currentRead.error)
    : null;
  const terminal = failure === "forbidden" || failure === "missing";
  const destination =
    read.data?.kind === "task" && !terminal && currentRead.admitted
      ? read.data.databaseId
      : null;
  // The owner read may settle after another pane becomes active.
  useEffect(() => {
    if (destination && destination !== databaseId && rowId)
      view.replace(
        `/databases/${destination}?${new URLSearchParams({ rowId })}`,
      );
  }, [destination, databaseId, rowId, view]);
  const hostScope = JSON.stringify([
    owner.identity,
    owner.workspace.id,
    databaseId,
  ]);
  const committedHost = useRef<string | null>(null);
  const pending =
    enabled &&
    !terminal &&
    !currentRead.error &&
    !destination &&
    (read.isLoading || !currentRead.admitted);
  const admittedHost =
    owner.availability.status === "available" &&
    Boolean(owner.identity && databaseId) &&
    (!rowId ||
      (currentRead.admitted &&
        !read.isLoading &&
        !terminal &&
        read.data &&
        read.data.kind !== "unavailable" &&
        (!destination || destination === databaseId)));
  useEffect(() => {
    if (admittedHost) committedHost.current = hostScope;
    else if (!pending || committedHost.current !== hostScope)
      committedHost.current = null;
  }, [admittedHost, hostScope, pending]);
  const renderChildren = (ownerAdmissionPending = false) =>
    typeof children === "function" ? children(ownerAdmissionPending) : children;
  if (!rowId || owner.availability.status !== "available")
    return renderChildren();
  const retry = () => {
    void currentRead.reload();
  };
  if (terminal) return renderState("forbidden", retry);
  // Keep an admitted list and its actual trigger mounted while a newly opened
  // Row is classified. The detail host must hide cached content until admitted.
  if (
    pending &&
    committedHost.current === hostScope &&
    typeof children === "function"
  )
    return renderChildren(true);
  if (
    read.isLoading ||
    (!currentRead.admitted && !currentRead.error) ||
    (destination && destination !== databaseId)
  )
    return renderState("loading", retry);
  if (
    !enabled ||
    !currentRead.admitted ||
    !read.data ||
    read.data.kind === "unavailable"
  )
    return renderState("unavailable", retry);
  return renderChildren();
}
