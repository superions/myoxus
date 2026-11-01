// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { WorkspaceServerService } from "@myoxus/core/modules/server/services/workspace-server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  DatabaseProfileKind,
  databaseRowQuery,
  clearDatabaseCellValueMutation,
  updateDatabaseCellValueMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { MenuItem, notify } from "@myoxus/ui-facade";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { managedTaskFields } from "../managed";
import { getDatabaseCellEditRevision } from "../model";
import { useDatabaseConflictController } from "../presence";
import type { DatabaseChangeHandler } from "../shared";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import { classifyDatabaseError } from "../route-state";

type Props = {
  enabled?: boolean;
  canEdit: boolean;
  record?: DatabaseRecord;
  row: DatabaseRowRecord;
  onChanged?: DatabaseChangeHandler;
  children: (item: ReactNode) => ReactNode;
};

function watcherField(record: DatabaseRecord) {
  return managedTaskFields(record)?.get("task.watchers");
}

// Own the mutation above Menu.items: native dropdown dismissal must not dispose
// a pending write, its scoped conflict, or the subsequent canonical readback.
export function TaskFollowMenuItem(props: Props) {
  if (props.enabled === false || !props.record || !props.onChanged)
    return props.children(null);
  if (
    props.record.database.profileKind !== DatabaseProfileKind.Project ||
    props.row.row.rowKind !== "task" ||
    props.row.redacted
  )
    return props.children(null);
  return (
    <TaskFollowOwner
      {...props}
      record={props.record}
      onChanged={props.onChanged}
    />
  );
}
type ResolvedProps = Props & {
  record: DatabaseRecord;
  onChanged: DatabaseChangeHandler;
};
function TaskFollowOwner(props: ResolvedProps) {
  const owner = useTaskIdentity();
  return (
    <TaskFollowSession
      key={JSON.stringify([
        owner.identity,
        props.record.database.id,
        props.row.row.id,
        watcherField(props.record)?.id,
      ])}
      {...props}
    />
  );
}
function TaskFollowSession({
  record,
  row,
  canEdit,
  onChanged,
  children,
}: ResolvedProps) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const servers = useService(WorkspaceServerService);
  const workspace = useService(WorkspaceService);
  const conflicts = useDatabaseConflictController();
  const dismiss = useRef(conflicts.dismiss);
  dismiss.current = conflicts.dismiss;
  const instance = useId();
  const scope = JSON.stringify([
    "task-follow",
    owner.identity,
    record.database.id,
    row.row.id,
    instance,
  ]);
  const field = watcherField(record);
  const users =
    row.cells.find((cell) => cell.fieldId === field?.id)?.value.users ?? [];
  const following = Boolean(owner.account && users.includes(owner.account.id));
  const revision = field ? getDatabaseCellEditRevision(row, field.id) : 0;
  const mutation = useMutation(
    { mutation: updateDatabaseCellValueMutation },
    { suppressErrorNotification: true },
  );
  const clear = useMutation(
    { mutation: clearDatabaseCellValueMutation },
    { suppressErrorNotification: true },
  );
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [awaitingRevision, setAwaitingRevision] = useState<number>();
  const pending = useRef(false);
  const alive = useRef(true);
  const read = useRef<AbortController | undefined>(undefined);
  const latest = useRef({ record, row, canEdit });
  latest.current = { record, row, canEdit };
  const available = Boolean(
    field &&
    canEdit &&
    !record.database.deletedAt &&
    !row.row.deletedAt &&
    owner.identity &&
    owner.server &&
    owner.account &&
    owner.workspace.id === record.database.workspaceId,
  );
  const isCurrent = () => {
    const server = servers.server$.value;
    return Boolean(
      alive.current &&
      server &&
      JSON.stringify([
        server.id,
        server.baseUrl,
        server.account$.value?.id,
        workspace.workspace.id,
      ]) === owner.identity &&
      latest.current.canEdit &&
      latest.current.record.database.workspaceId === owner.workspace.id &&
      !latest.current.record.database.deletedAt &&
      !latest.current.row.row.deletedAt &&
      watcherField(latest.current.record)?.id === field?.id,
    );
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
      dismiss.current?.(scope);
    };
  }, [scope]);
  useEffect(() => {
    if (awaitingRevision !== undefined && revision >= awaitingRevision)
      setAwaitingRevision(undefined);
  }, [revision, awaitingRevision]);
  const currentMembership = async () => {
    if (!isCurrent() || !owner.server || !owner.account || !field) return null;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    const response = await owner.server.gql({
      query: databaseRowQuery,
      variables: {
        workspaceId: record.database.workspaceId,
        databaseId: record.database.id,
        rowId: row.row.id,
      },
      context: { signal },
    });
    if (!isCurrent() || signal.aborted) return null;
    const current = response.workspace?.databaseRow;
    // Workspace is bound by the authorized query variable and current owner;
    // this operation projects only the Row, whose Database/Row IDs are checked.
    if (
      !current ||
      current.redacted ||
      current.row.deletedAt ||
      current.row.id !== row.row.id ||
      current.row.databaseId !== record.database.id ||
      current.row.rowKind !== "task"
    )
      return null;
    return {
      following:
        current.cells
          .find((cell) => cell.fieldId === field.id)
          ?.value.users?.includes(owner.account.id) ?? false,
      revision: getDatabaseCellEditRevision(current, field.id),
    };
  };
  const select = async () => {
    if (
      !available ||
      !isCurrent() ||
      !field ||
      !owner.account ||
      pending.current
    )
      return;
    pending.current = true;
    setBusy(true);
    let mutationReturned = false;
    const recovering = uncertain;
    try {
      if (uncertain) {
        const current = await currentMembership();
        if (!current || !isCurrent()) return;
        setAwaitingRevision(current.revision);
        await onChanged();
        if (isCurrent()) setUncertain(false);
        return;
      }
      const next = following
        ? users.filter((id) => id !== owner.account!.id)
        : [...users, owner.account.id];
      // A forced old Users array would erase someone else's concurrent follow.
      // The existing conflict owner offers canonical reload, never Force/replay.
      await conflicts.execute({
        scope,
        canOverwrite: isCurrent,
        allowOverwrite: false,
        attemptedAction: field.name,
        localValue: following
          ? t["com.myoxus.database.tasks.unfollow"]()
          : t["com.myoxus.database.tasks.follow"](),
        mutate: async () => {
          if (!isCurrent()) throw new Error("Task follow owner changed");
          try {
            const input = {
              databaseId: record.database.id,
              rowId: row.row.id,
              fieldId: field.id,
              expectedEditRevision: revision,
            };
            const result =
              !next.length && !field.required
                ? await clear.trigger({ input })
                : await mutation.trigger({
                    input: { ...input, value: { users: next } },
                  });
            mutationReturned = true;
            return result;
          } catch (error) {
            if (!isCurrent()) throw new Error("Task follow owner changed");
            throw error;
          }
        },
        readServerValue: async () => {
          const current = await currentMembership();
          return current
            ? current.following
              ? t["com.myoxus.database.tasks.follow-status-on"]()
              : t["com.myoxus.database.tasks.not-following"]()
            : null;
        },
        reloadLatest: () => (isCurrent() ? onChanged() : undefined),
        afterSuccess: async (result) => {
          if (!isCurrent()) return;
          const confirmed =
            "updateDatabaseCellValue" in result
              ? result.updateDatabaseCellValue?.editRevision
              : result.clearDatabaseCellValue?.editRevision;
          if (confirmed == null)
            throw new Error("Task follow write unconfirmed");
          setAwaitingRevision(confirmed);
          await onChanged({
            kind: "cell_updated",
            target: { rowId: row.row.id, fieldId: field.id },
          });
        },
      });
    } catch (error) {
      if (isCurrent()) {
        const status = classifyDatabaseError(error);
        const diagnostic = error as {
          extensions?: { code?: unknown; data?: { code?: unknown } };
        };
        const code =
          diagnostic?.extensions?.code ?? diagnostic?.extensions?.data?.code;
        const invalid =
          code === "MIX_DATABASE_CELL_VALUE_INVALID" ||
          code === "MIX_DATABASE_FIELD_REQUIRED" ||
          code === "MIX_DATABASE_FIELD_INVALID";
        // A rejected mutation differs from a failed read after its ACK. Only
        // unknown write outcomes require read-only recovery before a new intent.
        const rejected =
          !recovering &&
          !mutationReturned &&
          (status === "forbidden" || status === "missing" || invalid);
        setUncertain(!rejected);
        notify.error({
          title: rejected
            ? invalid
              ? t["com.myoxus.database.cell.validation-failed"]()
              : status === "forbidden"
                ? t["com.myoxus.database.row_detail.forbidden"]()
                : t["com.myoxus.database.row_detail.missing"]()
            : t["com.myoxus.database.tasks.follow-unconfirmed"](),
        });
        if (rejected) {
          try {
            await onChanged();
          } catch {
            if (isCurrent())
              notify.error({
                title: t["com.myoxus.database.row_detail.unavailable"](),
              });
          }
        }
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return children(
    <MenuItem
      disabled={
        !available || busy || (!uncertain && awaitingRevision !== undefined)
      }
      onSelect={() => void select()}
    >
      {!available
        ? t["com.myoxus.database.tasks.follow-unavailable"]()
        : uncertain
          ? t.Retry()
          : following
            ? t["com.myoxus.database.tasks.unfollow"]()
            : t["com.myoxus.database.tasks.follow"]()}
    </MenuItem>,
  );
}
