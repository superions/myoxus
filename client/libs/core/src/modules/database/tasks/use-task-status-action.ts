// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  databaseRowQuery,
  databaseSchemaQuery,
  DatabaseStatusGroup,
  updateDatabaseCellValueMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useEffect, useId, useRef, useState } from "react";

import { managedTaskFields } from "../managed";
import { getDatabaseCellEditRevision } from "../model";
import { useDatabaseConflictController } from "../presence";
import { executeRevisionMutation } from "../presence/execute-revision-mutation";
import { classifyDatabaseError } from "../route-state";
import { taskOptionDisplayName } from "../presentation/task-labels";
import { useTaskIdentity } from "./use-workspace-tasks";

type Target = { databaseId: string; rowId: string; title?: string };
type Undo = Target & { fieldId: string; value: string; revision: number };
export type TaskStatusOutcome = "applied" | "rejected" | "uncertain";

/** Mount above inventory membership: a completed Row can disappear before its
 * ACK/readback, conflict or Undo is resolved. Summary revisions are Row revisions;
 * only the canonical Cell (including its clear tombstone) authorizes this write.
 */
export function useTaskStatusAction(
  onChanged: () => Promise<unknown>,
  enabled = true,
) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const servers = useService(WorkspaceServerService);
  const workspaces = useService(WorkspaceService);
  const guard = useService(GuardService);
  const canWrite = useLiveData(guard.can$("Workspace_CreateDoc"));
  const canEdit = Boolean(canWrite && enabled);
  const conflicts = useDatabaseConflictController();
  const mutation = useMutation(
    { mutation: updateDatabaseCellValueMutation },
    { suppressErrorNotification: true },
  );
  const lifetime = useRef({ identity: owner.identity, canEdit, alive: true });
  if (
    lifetime.current.identity !== owner.identity ||
    lifetime.current.canEdit !== canEdit
  ) {
    lifetime.current.alive = false;
    lifetime.current = { identity: owner.identity, canEdit, alive: true };
  }
  const session = lifetime.current;
  const instance = useId();
  const scope = `task-status:${owner.identity}:${instance}`;
  const latest = useRef({ onChanged, canEdit });
  latest.current = { onChanged, canEdit };
  const locked = useRef(false);
  const [pending, setPending] = useState<Target | null>(null);
  const [uncertain, setUncertain] = useState<Target | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const current = () => {
    const server = servers.server$.value;
    return Boolean(
      session.alive &&
      lifetime.current === session &&
      server &&
      JSON.stringify([
        server.id,
        server.baseUrl,
        server.account$.value?.id,
        workspaces.workspace.id,
      ]) === session.identity &&
      latest.current.canEdit,
    );
  };
  useEffect(() => {
    session.alive = true;
    return () => {
      session.alive = false;
      conflicts.dismiss?.(scope);
    };
  }, [session, conflicts, scope]);
  useEffect(() => {
    setPending(null);
    setUncertain(null);
    setUndo(null);
    setFailed(false);
    setRefreshFailed(false);
    locked.current = false;
  }, [session]);
  const canonical = async (target: Target) => {
    if (!current() || !owner.server) throw new Error("Task owner unavailable");
    const variables = {
      workspaceId: owner.workspace.id,
      databaseId: target.databaseId,
    };
    const context = { signal: AbortSignal.timeout(15000) };
    const [schema, result] = await Promise.all([
      owner.server.gql({ query: databaseSchemaQuery, variables, context }),
      owner.server.gql({
        query: databaseRowQuery,
        variables: { ...variables, rowId: target.rowId },
        context,
      }),
    ]);
    const record = schema.workspace?.database;
    const row = result.workspace?.databaseRow;
    const field = record && managedTaskFields(record)?.get("task.status");
    if (
      !current() ||
      !record ||
      !field ||
      record.database.deletedAt ||
      record.database.workspaceId !== owner.workspace.id ||
      record.database.id !== target.databaseId ||
      !row ||
      row.redacted ||
      row.row.id !== target.rowId ||
      row.row.databaseId !== target.databaseId ||
      row.row.deletedAt ||
      row.row.rowKind !== "task"
    )
      throw new Error("Task status unavailable");
    const value = row.cells.find((cell) => cell.fieldId === field.id)?.value
      .status;
    // An absent Cell may use the native default. An unknown stored ID must not
    // be interpreted as Open or silently replaced by a quick action.
    if (
      value != null &&
      !field.config.status?.options.some((option) => option.id === value)
    )
      throw new Error("Task status unavailable");
    return {
      field,
      value,
      revision: getDatabaseCellEditRevision(row, field.id),
    };
  };
  const recover = async () => {
    if (!uncertain || locked.current || !current()) return;
    locked.current = true;
    setPending(uncertain);
    try {
      await canonical(uncertain);
      conflicts.dismiss?.(scope);
      await latest.current.onChanged();
      if (current()) {
        setUncertain(null);
        setFailed(false);
        setRefreshFailed(false);
      }
    } catch {
      if (current()) setFailed(true);
    } finally {
      if (lifetime.current === session) locked.current = false;
      if (current()) setPending(null);
    }
  };
  // Quick completion selects a semantic group; the detail picker selects an
  // explicit option. Both revalidate the canonical options and Cell revision.
  const change = async (
    target: Target,
    selection: boolean | string,
    revert?: Undo,
  ): Promise<TaskStatusOutcome> => {
    if (!current() || locked.current) return "rejected";
    if (uncertain) return "uncertain";
    locked.current = true;
    setPending(target);
    setFailed(false);
    setRefreshFailed(false);
    let dispatched = false;
    let acknowledged = false;
    let outcome: TaskStatusOutcome = "rejected";
    let applied = false;
    try {
      const basis = await canonical(target);
      const options =
        basis.field.config.status?.options.filter((option) =>
          typeof selection === "string"
            ? option.id === selection
            : option.group ===
              (selection
                ? DatabaseStatusGroup.Complete
                : DatabaseStatusGroup.NotStarted),
        ) ?? [];
      if (
        (!revert && options.length !== 1) ||
        (revert &&
          (revert.fieldId !== basis.field.id ||
            !basis.field.config.status?.options.some(
              (o) => o.id === revert.value,
            )))
      )
        throw new Error("Task status transition unavailable");
      const value = revert?.value ?? options[0].id;
      const previous =
        basis.value ?? basis.field.config.status?.defaultOptionId;
      const result = await executeRevisionMutation(
        conflicts,
        async (variables) => {
          if (variables.input.force) await canonical(target);
          if (!current()) throw new Error("Task status owner changed");
          dispatched = true;
          const result = await mutation.trigger(variables);
          acknowledged = true;
          return result;
        },
        {
          databaseId: target.databaseId,
          rowId: target.rowId,
          fieldId: basis.field.id,
          expectedEditRevision: revert?.revision ?? basis.revision,
          value: { status: value },
        },
        {
          scope,
          canOverwrite: current,
          attemptedAction: t.Status(),
          localValue: taskOptionDisplayName(t, "task.status", value),
          readServerValue: async () => {
            const read = await canonical(target);
            return read.value
              ? taskOptionDisplayName(t, "task.status", read.value)
              : null;
          },
          reloadLatest: async () => {
            await canonical(target);
            await latest.current.onChanged();
            if (current()) {
              setUncertain(null);
              setFailed(false);
            }
          },
          afterSuccess: async (result) => {
            if (!current()) return;
            const revision = result.updateDatabaseCellValue?.editRevision;
            if (revision == null) throw new Error("Task status unconfirmed");
            // A failed inventory refresh cannot erase this returned-revision ACK.
            // Retain the recovery fence below, but never replay this write.
            applied = true;
            setRefreshFailed(false);
            setUndo(
              !revert && previous
                ? {
                    ...target,
                    fieldId: basis.field.id,
                    value: previous,
                    revision,
                  }
                : null,
            );
            await latest.current.onChanged();
            if (current()) setUncertain(null);
          },
        },
      );
      // Conflict ownership outlives the filtered Row and remains read-only until
      // the shared dialog resolves it or the explicit canonical recovery runs.
      if (result === undefined && current() && !applied) {
        outcome = "uncertain";
        setUncertain(target);
      }
    } catch (error) {
      if (current()) {
        setFailed(true);
        const rejected =
          !acknowledged &&
          ["forbidden", "missing"].includes(classifyDatabaseError(error));
        if (dispatched && !rejected) {
          setUncertain(target);
          if (applied) setRefreshFailed(true);
          else outcome = "uncertain";
        }
      }
    } finally {
      if (lifetime.current === session) locked.current = false;
      if (current()) setPending(null);
    }
    return current() ? (applied ? "applied" : outcome) : "rejected";
  };
  return {
    canEdit,
    pending,
    uncertain,
    undo,
    failed,
    refreshFailed,
    change,
    recover,
    undoLast: () => undo && change(undo, false, undo),
    dismissUndo: () => setUndo(null),
  };
}
