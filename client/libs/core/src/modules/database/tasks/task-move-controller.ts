// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  DatabaseTaskReferenceState,
  databaseSchemaQuery,
  databaseRowQuery,
  databaseRowsQuery,
  databaseTaskReferencesQuery,
  prepareDatabaseTaskMoveQuery,
  moveDatabaseTasksMutation,
  type DatabaseTaskMoveInput,
  type QueryResponse,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import useSWRInfinite, {
  type SWRInfiniteConfiguration,
  type SWRInfiniteKeyLoader,
} from "swr/infinite";
import type { SWRFailureNotificationOptions } from "@myoxus/core/components/providers/swr-config-provider";
import { databaseManagedCapabilities } from "../managed";
import { openDatabaseDialogAfterMenuClose } from "../view-controls";
import { classifyDatabaseError } from "../route-state";
import type { DatabaseChangeHandler } from "../shared";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import { useTaskDestinations, useTaskIdentity } from "./use-workspace-tasks";

type MembershipResponse = QueryResponse<typeof databaseRowsQuery>;
type MembershipKeyLoader = SWRInfiniteKeyLoader<
  MembershipResponse,
  readonly [string, string, string, string | null] | null
>;
const membershipReadOptions: SWRInfiniteConfiguration<
  MembershipResponse,
  Error
> &
  SWRFailureNotificationOptions = {
  suspense: false,
  keepPreviousData: false,
  suppressErrorNotification: true,
  persistSize: false,
};

type Preview = NonNullable<
  QueryResponse<typeof prepareDatabaseTaskMoveQuery>["workspace"]
>["prepareDatabaseTaskMove"];
function membershipContinuation(
  response: QueryResponse<typeof databaseRowsQuery> | undefined,
  loadedCount: number,
) {
  const page = response?.workspace?.databaseRows;
  return page?.endCursor && page.totalCount > loadedCount
    ? page.endCursor
    : null;
}

export type TaskMoveRetentionSlot = {
  current:
    | {
        owner: string;
        rowIds: string[];
        targetId: string;
        phaseId: string;
        milestoneId: string;
        uncertain: boolean;
      }
    | undefined;
};

export type TaskMoveControllerProps = {
  retention?: TaskMoveRetentionSlot;
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  onChanged: DatabaseChangeHandler;
  onClose: () => void;
  identity: string;
  server: NonNullable<ReturnType<typeof useTaskIdentity>["server"]>;
  workspaceId: string;
};

/** Owns the existing native move lifetime independently of its presentation.
 * Preview keeps exact server fences; ambiguous writes require current-owner
 * readback and never replay when a modal is reopened or dismissed. */
export function useTaskMoveController({
  record,
  row,
  onChanged,
  onClose,
  retention,
  identity,
  server,
  workspaceId,
}: TaskMoveControllerProps) {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const destinations = useTaskDestinations();
  const retentionOwner = JSON.stringify([
    identity,
    record.database.id,
    row.row.id,
  ]);
  const retained = useRef(
    retention?.current?.owner === retentionOwner
      ? retention.current
      : undefined,
  ).current;
  const [targetId, setTargetId] = useState(retained?.targetId ?? "");
  const [selection, setSelection] = useState([row]);
  const [source, setSource] = useState(record);
  const [phaseId, setPhaseId] = useState(retained?.phaseId ?? "");
  const [milestoneId, setMilestoneId] = useState(retained?.milestoneId ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<
    "draft" | "previewing" | "pending" | "uncertain" | "denied"
  >(retained?.uncertain ? "uncertain" : retained ? "previewing" : "draft");
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const sequence = useRef(0);
  const committing = useRef(false);
  const currentOwner = useTaskIdentity();
  const ownerRef = useRef(currentOwner.identity);
  ownerRef.current = currentOwner.identity;
  useEffect(() => {
    alive.current = true;
    const invalidate = () => {
      sequence.current++;
    };
    return () => {
      alive.current = false;
      invalidate();
    };
  }, []);
  const current = (attempt: number) =>
    alive.current &&
    ownerRef.current === identity &&
    sequence.current === attempt;
  const target = useSWR(
    targetId ? ["task-move-target", identity, targetId] : null,
    () =>
      server.gql({
        query: databaseSchemaQuery,
        variables: { workspaceId, databaseId: targetId },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
    },
  );
  const targetRecord = target.data?.workspace?.database;
  const supportsPhase = Boolean(
    targetRecord?.managedSchema?.readiness === "Ready" &&
    targetRecord.managedSchema.taskBindings.some(
      (binding) => binding.roleKey === "task.phase",
    ),
  );
  const supportsMilestone = Boolean(
    targetRecord?.managedSchema?.readiness === "Ready" &&
    targetRecord.managedSchema.taskBindings.some(
      (binding) => binding.roleKey === "task.milestone",
    ),
  );
  const membershipPages = useRef<QueryResponse<typeof databaseRowsQuery>[]>([]);
  const membershipOwner = useRef(targetId);
  if (membershipOwner.current !== targetId) {
    membershipOwner.current = targetId;
    membershipPages.current = [];
  }
  const targetRows = useSWRInfinite<
    MembershipResponse,
    Error,
    MembershipKeyLoader
  >(
    (index, previous) => {
      if (!targetId || (!supportsPhase && !supportsMilestone)) return null;
      const loadedPrefix = membershipPages.current
        .slice(0, Math.max(0, index - 1))
        .reduce(
          (count, page) =>
            count + (page.workspace?.databaseRows.rows.length ?? 0),
          0,
        );
      const after = index
        ? membershipContinuation(
            previous ?? undefined,
            loadedPrefix + (previous?.workspace?.databaseRows.rows.length ?? 0),
          )
        : null;
      if (index && !after) return null;
      return ["task-move-memberships", identity, targetId, after];
    },
    ([, , , after]) =>
      server.gql({
        query: databaseRowsQuery,
        variables: {
          workspaceId,
          databaseId: targetId,
          first: 100,
          after: after ?? undefined,
        },
      }),
    membershipReadOptions,
  );
  membershipPages.current = targetRows.data ?? [];
  const membershipRows =
    supportsPhase || supportsMilestone
      ? (targetRows.data?.flatMap(
          (page) => page.workspace?.databaseRows.rows ?? [],
        ) ?? [])
      : [];
  const relatedIds = [
    ...new Set([
      ...(preview?.requiredRelatedTasks ?? []),
      ...(preview?.boundaries.flatMap((boundary) => [
        boundary.rowId,
        boundary.relatedRowId,
      ]) ?? []),
    ]),
  ].slice(0, 100);
  const related = useSWR(
    preview && relatedIds.length
      ? ["task-move-related", identity, source.database.id, relatedIds]
      : null,
    async () => {
      const results = await Promise.allSettled(
        relatedIds.map((rowId) =>
          server.gql({
            query: databaseRowQuery,
            variables: {
              workspaceId,
              databaseId: source.database.id,
              rowId,
              includeTrashed: true,
            },
          }),
        ),
      );
      return results.map((result, index) => {
        const id = relatedIds[index]!;
        if (result.status === "rejected") {
          const kind = classifyDatabaseError(result.reason);
          return {
            id,
            row: null,
            failed: kind !== "forbidden" && kind !== "missing",
          };
        }
        const row = result.value.workspace?.databaseRow;
        return {
          id,
          row:
            row &&
            !row.redacted &&
            row.row.id === id &&
            row.row.databaseId === source.database.id
              ? row
              : null,
          failed: false,
        };
      });
    },
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
    },
  );
  const projectChoices = destinations.projects.filter(
    (project) => project.managedSchema.readiness === "Ready",
  );
  const selectedIds = useMemo(
    () =>
      phase === "uncertain" && retained?.uncertain
        ? retained.rowIds
        : selection.map((row) => row.row.id),
    [phase, retained, selection],
  );
  const expansionTooLarge =
    new Set([
      ...selection.map((row) => row.row.id),
      ...(preview?.requiredRelatedTasks ?? []),
    ]).size > 100;
  const locked =
    phase === "pending" || phase === "uncertain" || phase === "denied";
  const invalidate = () => {
    sequence.current++;
    setPreview(null);
    setFailed(false);
    setPhase("draft");
  };
  const chooseTarget = (id: string) => {
    invalidate();
    setTargetId(id);
    setPhaseId("");
    setMilestoneId("");
  };
  const readRows = async (ids: string[]) =>
    Promise.all(
      ids.map(async (rowId) => {
        const response = await server.gql({
          query: databaseRowQuery,
          variables: {
            workspaceId,
            databaseId: source.database.id,
            rowId,
            includeTrashed: true,
          },
        });
        const row = response.workspace?.databaseRow;
        if (
          !row ||
          row.redacted ||
          row.row.databaseId !== source.database.id ||
          row.row.deletedAt ||
          row.row.rowKind !== "task"
        )
          throw new Error("Task selection unavailable");
        return row;
      }),
    );
  useEffect(() => {
    if (!retained || retained.uncertain) return;
    let active = true;
    Promise.all(
      retained.rowIds.map(async (rowId) => {
        const response = await server.gql({
          query: databaseRowQuery,
          variables: {
            workspaceId,
            databaseId: record.database.id,
            rowId,
            includeTrashed: true,
          },
        });
        const selected = response.workspace?.databaseRow;
        if (
          !selected ||
          selected.redacted ||
          selected.row.databaseId !== record.database.id ||
          selected.row.deletedAt ||
          selected.row.rowKind !== "task"
        )
          throw new Error("Retained selection unavailable");
        return selected;
      }),
    ).then(
      (rows) => {
        if (active) {
          setSelection(rows);
          setPhase("draft");
        }
      },
      () => {
        if (active) {
          setFailed(true);
          setPhase("denied");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [retained, server, workspaceId, record.database.id]);
  useEffect(() => {
    if (retention && (phase === "draft" || phase === "uncertain"))
      retention.current = {
        owner: retentionOwner,
        rowIds: selectedIds,
        targetId,
        phaseId,
        milestoneId,
        uncertain: phase === "uncertain",
      };
  }, [
    retention,
    retentionOwner,
    selectedIds,
    targetId,
    phaseId,
    milestoneId,
    phase,
  ]);
  const openRelated = (rowId: string, trashed: boolean) => {
    const path = trashed
      ? `/tasks?${new URLSearchParams({ scope: "All", lifecycle: "Trash", databaseId: source.database.id, rowId })}`
      : `/databases/${source.database.id}?${new URLSearchParams({ rowId })}`;
    onClose();
    openDatabaseDialogAfterMenuClose(() =>
      workbench.open(path, { at: "new-tab" }),
    );
  };
  const createProject = () => {
    // Release the global focus trap before entering the existing assistant.
    onClose();
    openDatabaseDialogAfterMenuClose(() =>
      workbench.open("/databases?create=project&structurePreset=TasksOnly", {
        at: "new-tab",
      }),
    );
  };
  const prepare = async (
    selected = selection,
    membership?: { phaseRowId?: string; milestoneRowId?: string },
  ) => {
    if (!targetRecord?.managedSchema || !source.managedSchema || locked) return;
    const attempt = ++sequence.current;
    setPhase("previewing");
    setFailed(false);
    setPreview(null);
    const input: DatabaseTaskMoveInput = {
      workspaceId,
      sourceDatabaseId: source.database.id,
      targetDatabaseId: targetId,
      sourceEditRevision: source.database.editRevision,
      targetEditRevision: targetRecord.database.editRevision,
      sourceSchemaRevision: source.managedSchema.schemaRevision,
      targetSchemaRevision: targetRecord.managedSchema.schemaRevision,
      selection: selected.map((row) => ({
        rowId: row.row.id,
        expectedEditRevision: row.row.editRevision,
        cellRevisions: row.cellRevisions.map((revision) => ({
          fieldId: revision.fieldId,
          expectedEditRevision: revision.editRevision,
        })),
      })),
      phaseRowId: membership ? membership.phaseRowId : phaseId || undefined,
      milestoneRowId: membership
        ? membership.milestoneRowId
        : milestoneId || undefined,
    };
    try {
      const response = await server.gql({
        query: prepareDatabaseTaskMoveQuery,
        variables: { workspaceId, input },
      });
      const result = response.workspace?.prepareDatabaseTaskMove;
      if (!result) throw new Error("Task move preview unavailable");
      if (current(attempt)) {
        setPreview(result);
        setPhase("draft");
      }
    } catch (error) {
      if (current(attempt)) {
        setFailed(true);
        setPhase(
          classifyDatabaseError(error) === "forbidden" ? "denied" : "draft",
        );
      }
    }
  };
  const refresh = async () => {
    invalidate();
    setPhase("previewing");
    const attempt = sequence.current;
    try {
      const [schema, rows] = await Promise.all([
        server.gql({
          query: databaseSchemaQuery,
          variables: { workspaceId, databaseId: source.database.id },
        }),
        readRows(selectedIds),
        target.mutate(),
        destinations.mutate(),
      ]);
      const latest = schema.workspace?.database;
      if (!latest || !databaseManagedCapabilities(latest).ready)
        throw new Error("Task source unavailable");
      if (current(attempt)) {
        setSource({ ...source, ...latest });
        setSelection(rows);
        setPhase("draft");
      }
    } catch (error) {
      if (current(attempt)) {
        setFailed(true);
        setPhase(
          classifyDatabaseError(error) === "forbidden" ? "denied" : "draft",
        );
      }
    }
  };
  const expand = async () => {
    const ids = [
      ...new Set([
        ...selection.map((row) => row.row.id),
        ...(preview?.requiredRelatedTasks ?? []),
      ]),
    ];
    if (ids.length > 100) return;
    const attempt = ++sequence.current;
    setPhase("previewing");
    setFailed(false);
    try {
      const rows = await readRows(ids);
      if (current(attempt)) {
        setSelection(rows);
        setPhase("draft");
        setPreview(null);
      }
    } catch (error) {
      if (current(attempt)) {
        setFailed(true);
        setPhase(
          classifyDatabaseError(error) === "forbidden" ? "denied" : "draft",
        );
      }
    }
  };
  const openMoved = (databaseId: string) => {
    workbench.open(
      `/databases/${databaseId}?${new URLSearchParams({ rowId: row.row.id })}`,
      { at: "active" },
    );
    if (retention) retention.current = undefined;
    onClose();
  };
  const commit = async () => {
    if (
      !current(sequence.current) ||
      !preview?.eligible ||
      locked ||
      committing.current
    )
      return;
    committing.current = true;
    const attempt = ++sequence.current;
    // An owner/read-permission unmount can precede the response and the next
    // render. Retain ambiguity before dispatch, not only after its catch.
    if (retention)
      retention.current = {
        owner: retentionOwner,
        rowIds: preview.input.selection.map((selected) => selected.rowId),
        targetId: preview.input.targetDatabaseId,
        phaseId: preview.input.phaseRowId ?? "",
        milestoneId: preview.input.milestoneRowId ?? "",
        uncertain: true,
      };
    setPhase("pending");
    setFailed(false);
    try {
      const response = await server.gql({
        query: moveDatabaseTasksMutation,
        variables: { input: preview.input },
      });
      if (!current(attempt)) return;
      const result = response.moveDatabaseTasks;
      const original = result.rows.find((moved) => moved.row.id === row.row.id);
      if (!original || original.row.databaseId !== result.targetDatabaseId)
        throw new Error("Task move acknowledgement incomplete");
      const ids = result.rows.flatMap((row) =>
        row.cells.flatMap((cell) =>
          cell.value.uniqueId?.display ? [cell.value.uniqueId.display] : [],
        ),
      );
      notify.success({
        title: t["com.myoxus.database.tasks.move-to-project"](),
        message: ids.join(", "),
      });
      // The acknowledged move is complete even if a subsequent inventory refresh fails.
      void onChanged().catch(() =>
        notify.error({ title: t["com.myoxus.database.view.update-failed"]() }),
      );
      openMoved(result.targetDatabaseId);
    } catch {
      if (current(attempt)) {
        setFailed(true);
        // Native SQL commits before its result readback. Even a typed failure
        // cannot prove that replay is safe; resolve the current owners first.
        setPhase("uncertain");
      }
    } finally {
      committing.current = false;
    }
  };
  const check = async () => {
    const attempt = ++sequence.current;
    setFailed(false);
    try {
      const response = await server.gql({
        query: databaseTaskReferencesQuery,
        variables: {
          workspaceId,
          targets: selectedIds.map((rowId) => ({
            workspaceId,
            databaseId: source.database.id,
            rowId,
          })),
        },
      });
      if (!current(attempt)) return;
      const references = response.workspace?.databaseTaskReferences;
      if (
        !references ||
        references.length !== selectedIds.length ||
        references.some(
          (ref, index) =>
            ref.state !== DatabaseTaskReferenceState.Available ||
            !ref.task ||
            ref.task.workspaceId !== workspaceId ||
            ref.task.rowId !== selectedIds[index] ||
            ref.workspaceId !== workspaceId ||
            ref.rowId !== selectedIds[index] ||
            ref.databaseId !== ref.task.databaseId,
        )
      ) {
        setPhase("denied");
        return;
      }
      if (references.every((ref) => ref.task?.databaseId === targetId)) {
        void onChanged().catch(() =>
          notify.error({
            title: t["com.myoxus.database.view.update-failed"](),
          }),
        );
        openMoved(targetId);
        return;
      }
      if (
        references.every((ref) => ref.task?.databaseId === source.database.id)
      ) {
        setPhase("draft");
        setPreview(null);
        await refresh();
        return;
      }
      setFailed(true);
    } catch {
      if (current(attempt)) setFailed(true);
    }
  };
  return {
    destinations,
    target,
    targetRecord,
    source,
    supportsPhase,
    supportsMilestone,
    targetRows,
    membershipRows,
    selection,
    phaseId,
    milestoneId,
    preview,
    phase,
    failed,
    related,
    projectChoices,
    selectedIds,
    expansionTooLarge,
    locked,
    invalidate,
    setPhaseId,
    setMilestoneId,
    openRelated,
    createProject,
    prepare,
    refresh,
    expand,
    commit,
    check,
    chooseTarget,
    targetId,
    hasMoreMemberships: Boolean(
      (supportsPhase || supportsMilestone) &&
      membershipContinuation(targetRows.data?.at(-1), membershipRows.length),
    ),
  };
}
