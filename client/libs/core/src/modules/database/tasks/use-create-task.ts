// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Server } from "@myoxus/core/modules/server/entities/server";
import {
  createDatabaseRowMutation,
  databaseTasksQuery,
  DatabaseTaskScope,
  DatabaseTaskLifecycle,
  type DatabaseCellValueInput,
} from "@myoxus/graphql";
import { useEffect, useRef, useState } from "react";
import type { CreateRowFromTemplateVariables } from "../row-templates/use-create-row-from-template";
import type { QueryResponse } from "@myoxus/graphql";
import type { createDatabaseRowFromTemplateMutation } from "@myoxus/graphql";
import { taskParentErrorReason } from "../relation/task-parent-reason";
import { richTextDocumentFromPlainText } from "../table/clipboard";

export type CreatedTask = { databaseId: string; rowId: string; title: string };
export type TaskCreationCell = {
  fieldId: string;
  value: Pick<
    DatabaseCellValueInput,
    "users" | "dateTime" | "relation" | "richText"
  >;
};

/** Description belongs to the initial Row write; preserve all nonblank draft text. */
export function taskDescriptionCell(
  fieldId: string,
  text: string,
): TaskCreationCell | undefined {
  if (!text.trim()) return undefined;
  return {
    fieldId,
    value: { richText: { document: richTextDocumentFromPlainText(text) } },
  };
}

type Draft = {
  title: string;
  templateId: string;
  cells: TaskCreationCell[];
};

export type TaskCreationRetention = {
  owner: string;
  draft: Draft;
  phase: "draft" | "uncertain" | "confirmed";
  confirmed?: { databaseId: string; rowId: string };
};
export type TaskCreationRetentionSlot = {
  current: TaskCreationRetention | undefined;
};
export const taskCreationOwnerKey = (
  identity: string,
  databaseId: string,
  scope = "",
) => JSON.stringify([identity, databaseId, scope]);

/** A create is never replayed automatically. Even a typed error can follow a
 * committed Row: the canonical repository reads it back after its transaction.
 * Owner changes fence completions; a confirmed UUID survives refresh failures.
 */
export function useCreateTask({
  server,
  identity,
  workspaceId,
  databaseId,
  timeZone,
  onCreated,
  isCurrent,
  creationScope,
  retention,
  createFromTemplate,
}: {
  server: Server;
  createFromTemplate?: (
    variables: CreateRowFromTemplateVariables,
  ) => Promise<
    QueryResponse<typeof createDatabaseRowFromTemplateMutation> | undefined
  >;
  identity: string;
  workspaceId: string;
  databaseId: string;
  timeZone: string;
  onCreated: (task: CreatedTask) => void;
  isCurrent?: () => boolean;
  creationScope?: string;
  retention?: TaskCreationRetentionSlot;
}) {
  const owner = taskCreationOwnerKey(identity, databaseId, creationScope);
  const retained =
    retention?.current?.owner === owner ? retention.current : undefined;
  const [phase, setPhase] = useState<
    "draft" | "pending" | "uncertain" | "confirmed"
  >(retained?.phase ?? "draft");
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState<
    "required" | "invalid" | "unconfirmed" | null
  >(retained?.phase === "uncertain" ? "unconfirmed" : null);
  const [relationReason, setRelationReason] = useState<string>();
  const [reviewCount, setReviewCount] = useState(0);
  const [checking, setChecking] = useState(false);
  const [reviewFailed, setReviewFailed] = useState(false);
  const [candidates, setCandidates] = useState<CreatedTask[]>([]);
  const ownerRef = useRef({ key: owner, generation: 0 });
  if (ownerRef.current.key !== owner)
    ownerRef.current = {
      key: owner,
      generation: ownerRef.current.generation + 1,
    };
  const alive = useRef(true);
  const busy = useRef(false);
  const attempt = useRef<Draft | null>(retained?.draft ?? null);
  const confirmed = useRef<CreatedTask | null>(
    retained?.confirmed
      ? { ...retained.confirmed, title: retained.draft.title.trim() }
      : null,
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const restored =
      retention?.current?.owner === owner ? retention.current : undefined;
    setFailure(restored?.phase === "uncertain" ? "unconfirmed" : null);
    setRelationReason(undefined);
    setReviewCount(0);
    setPhase(restored?.phase ?? "draft");
    setChecked(false);
    setChecking(false);
    setReviewFailed(false);
    setCandidates([]);
    busy.current = false;
    attempt.current = restored?.draft ?? null;
    confirmed.current = restored?.confirmed
      ? { ...restored.confirmed, title: restored.draft.title.trim() }
      : null;
  }, [owner, retention]);
  const current = (captured: typeof ownerRef.current) =>
    alive.current && ownerRef.current === captured && (isCurrent?.() ?? true);
  const clearRetained = () => {
    if (retention?.current?.owner === owner) retention.current = undefined;
  };
  const submit = async (draft: Draft): Promise<boolean> => {
    if (
      (retention?.current &&
        retention.current.phase !== "confirmed" &&
        retention.current.owner !== owner) ||
      busy.current ||
      confirmed.current ||
      phase !== "draft" ||
      !current(ownerRef.current) ||
      !draft.title.trim()
    )
      return false;
    busy.current = true;
    const captured = ownerRef.current;
    attempt.current = draft;
    // The outer detail owns one private attempt across internal Open/Back.
    // If this keyed Row unmounts while pending, its outcome is conservatively
    // uncertain; candidate titles are never retained and no replay is started.
    if (retention) retention.current = { owner, draft, phase: "uncertain" };
    setFailure(null);
    setRelationReason(undefined);
    setPhase("pending");
    let task: CreatedTask;
    try {
      let rowId: string;
      if (draft.templateId) {
        // Consumers offering only ordinary creation do not resolve prompt services.
        if (!createFromTemplate) {
          clearRetained();
          busy.current = false;
          setPhase("draft");
          setFailure("invalid");
          return false;
        }
        const result = await createFromTemplate({
          input: {
            databaseId,
            rowTemplateId: draft.templateId,
            title: draft.title.trim(),
            overrideCellValues: draft.cells,
          },
        });
        if (!result) {
          // A cancelled prompt has not written, even if its UI owner moved on.
          clearRetained();
          if (current(captured)) {
            busy.current = false;
            setPhase("draft");
          }
          return false;
        }
        rowId = result.createDatabaseRowFromTemplate.row.id;
      } else {
        rowId = (
          await server.gql({
            query: createDatabaseRowMutation,
            variables: {
              input: {
                databaseId,
                title: draft.title.trim(),
                cells: draft.cells,
              },
            },
          })
        ).createDatabaseRow.row.id;
      }
      task = { databaseId, rowId, title: draft.title.trim() };
    } catch (error) {
      if (current(captured)) {
        const diagnostic = error as {
          message?: unknown;
          extensions?: { code?: unknown; data?: { code?: unknown } };
        };
        const code =
          diagnostic?.extensions?.code ?? diagnostic?.extensions?.data?.code;
        // These codes originate in the traced application preflight. Generic
        // FIELD_INVALID/NOT_FOUND can instead follow a committed repository write.
        const rejected =
          code === "MIX_DATABASE_CELL_VALUE_INVALID" ||
          code === "MIX_DATABASE_FIELD_REQUIRED" ||
          code === "MIX_DATABASE_TASK_RELATION_INVALID" ||
          [
            "MIX_DATABASE_ROW_TEMPLATE_TEMPLATE_INVALID",
            "MIX_DATABASE_ROW_TEMPLATE_FORBIDDEN",
            "MIX_DATABASE_ROW_TEMPLATE_NOT_FOUND",
            "MIX_DATABASE_ROW_TEMPLATE_RECONCILE_REQUIRED",
          ].includes(String(code));
        if (rejected) {
          if (retention)
            retention.current = {
              owner,
              draft: structuredClone(draft),
              phase: "draft",
            };
          else clearRetained();
        }
        busy.current = false;
        setRelationReason(taskParentErrorReason(error));
        setFailure(
          code === "MIX_DATABASE_FIELD_REQUIRED"
            ? "required"
            : rejected
              ? "invalid"
              : "unconfirmed",
        );
        setPhase(rejected ? "draft" : "uncertain");
        setChecked(false);
      }
      return false;
    }
    if (!current(captured)) return false;
    confirmed.current = task;
    if (retention)
      retention.current = {
        owner,
        draft,
        phase: "confirmed",
        confirmed: { databaseId: task.databaseId, rowId: task.rowId },
      };
    busy.current = false;
    setPhase("confirmed");
    // Consumer navigation/revalidation is deliberately outside the write catch.
    // A failed refresh cannot revoke the confirmed identity or permit a replay.
    onCreated(task);
    return true;
  };
  const review = async () => {
    if (
      phase !== "uncertain" ||
      checking ||
      !attempt.current ||
      !current(ownerRef.current)
    )
      return;
    const captured = ownerRef.current;
    setChecking(true);
    setReviewFailed(false);
    try {
      const results = await Promise.all(
        [DatabaseTaskLifecycle.Open, DatabaseTaskLifecycle.Closed].map(
          (lifecycle) =>
            server.gql({
              query: databaseTasksQuery,
              variables: {
                workspaceId,
                input: {
                  scope: DatabaseTaskScope.All,
                  lifecycle,
                  projectIds: [databaseId],
                  search: attempt.current!.title.trim(),
                  timeZone,
                },
                first: 100,
              },
            }),
        ),
      );
      if (!current(captured)) return;
      const pages = results.map((result) => result.workspace?.databaseTasks);
      if (pages.some((page) => !page))
        throw new Error("Task inventory unavailable");
      // Lifecycle reads are independent snapshots; a concurrently moved Row
      // can appear in both. Preserve one canonical identity in the review list.
      setCandidates([
        ...new Map(
          pages.flatMap((page) =>
            page!.rows.map(
              (row) =>
                [
                  row.rowId,
                  {
                    databaseId: row.databaseId,
                    rowId: row.rowId,
                    title: row.title,
                  },
                ] as const,
            ),
          ),
        ).values(),
      ]);
      setReviewCount(
        pages.reduce((total, page) => total + page!.totalCount, 0),
      );
      setChecked(true);
    } catch {
      if (current(captured)) setReviewFailed(true);
    } finally {
      if (current(captured)) setChecking(false);
    }
  };
  const allowAnotherAttempt = () => {
    // A successful read is an opportunity to inspect, never proof of rollback:
    // matching Rows may predate this attempt, and absence is not a write receipt.
    if (phase === "uncertain" && checked && current(ownerRef.current)) {
      clearRetained();
      attempt.current = null;
      setFailure(null);
      setRelationReason(undefined);
      setPhase("draft");
      setChecked(false);
      setCandidates([]);
    }
  };
  /** Preserve only an editable draft; an unresolved or confirmed write owns its slot. */
  const preserveDraft = (draft: Draft): boolean => {
    if (
      !retention ||
      // prepareNext clears the confirmed ref before its phase render; retain
      // that first new keystroke without overwriting any confirmed intent.
      (phase !== "draft" && phase !== "confirmed") ||
      busy.current ||
      confirmed.current ||
      !current(ownerRef.current) ||
      (retention.current &&
        (retention.current.owner !== owner ||
          retention.current.phase !== "draft"))
    )
      return false;
    retention.current = {
      owner,
      draft: structuredClone(draft),
      phase: "draft",
    };
    return true;
  };
  const discardDraft = (): boolean => {
    if (
      phase !== "draft" ||
      busy.current ||
      confirmed.current ||
      !current(ownerRef.current) ||
      (retention?.current?.owner === owner &&
        retention.current.phase !== "draft")
    )
      return false;
    clearRetained();
    attempt.current = null;
    setFailure(null);
    setRelationReason(undefined);
    return true;
  };
  const prepareNext = () => {
    if (!confirmed.current || busy.current || !current(ownerRef.current))
      return;
    clearRetained();
    confirmed.current = null;
    attempt.current = null;
    setFailure(null);
    setRelationReason(undefined);
    setPhase("draft");
    setChecked(false);
    setCandidates([]);
  };
  return {
    phase,
    blockedByRetainedAttempt: Boolean(
      retention?.current &&
      retention.current.phase !== "confirmed" &&
      retention.current.owner !== owner,
    ),
    failure,
    relationReason,
    reviewCount,
    checking,
    checked,
    reviewFailed,
    candidates,
    submit,
    preserveDraft,
    discardDraft,
    review,
    allowAnotherAttempt,
    prepareNext,
  };
}
