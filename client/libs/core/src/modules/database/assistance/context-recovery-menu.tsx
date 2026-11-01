// SPDX-License-Identifier: AGPL-3.0-or-later
import { GlobalState } from "@myoxus/core/modules/storage";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { MenuItem, MenuPanel, MenuSub } from "@myoxus/ui-facade";
import { useEffect, useState } from "react";

import type { ContextDocumentMenuTarget } from "./context";
import {
  contextDocumentsAttemptKey,
  readContextDocumentsAttempt,
  type ContextDocumentsAttempt,
} from "./context-documents-attempt";

/** These three known transport slots only discover recovery. Opening still
 * requires the native receipt to authorize its current accepted descriptor. */
export function useRetainedContextAttempts(
  serverId: string,
  actorId: string,
  workspaceId: string,
  target: ContextDocumentMenuTarget | undefined,
  revision = 0,
): ContextDocumentsAttempt[] {
  const state = useService(GlobalState);
  const databaseId = target?.databaseId;
  const taskId = target?.taskId ?? null;
  const identity = JSON.stringify([
    serverId,
    actorId,
    workspaceId,
    databaseId,
    taskId,
  ]);
  const [projection, setProjection] = useState<{
    identity: string;
    attempts: ContextDocumentsAttempt[];
  }>();
  useEffect(() => {
    let active = true;
    let generation = 0;
    setProjection(undefined);
    if (!serverId || !actorId || !workspaceId || !databaseId) return;
    const slots = [undefined, "taskHandover", "taskMaintenance"] as const;
    const keys = slots.map((slot) =>
      contextDocumentsAttemptKey(
        serverId,
        actorId,
        workspaceId,
        databaseId,
        taskId,
        slot,
      ),
    );
    const read = async () => {
      const epoch = ++generation;
      try {
        const values = await Promise.all(
          keys.map((key) => readContextDocumentsAttempt(state, key)),
        );
        if (!active || epoch !== generation) return;
        const attempts = values.filter(
          (attempt, index): attempt is ContextDocumentsAttempt =>
            Boolean(
              attempt &&
              !attempt.gone &&
              attempt.input.workspaceId === workspaceId &&
              attempt.input.target.databaseId === databaseId &&
              (attempt.input.target.taskId ?? null) === taskId &&
              (slots[index]
                ? attempt.product === slots[index]
                : attempt.product === undefined ||
                  attempt.product === "documentReview"),
            ),
        );
        setProjection({ identity, attempts });
      } catch {
        if (active && epoch === generation)
          setProjection({ identity, attempts: [] });
      }
    };
    const subscriptions = keys.map((key) =>
      state.watch(key).subscribe({
        next: () => void read(),
        error: () => {
          ++generation;
          if (active) setProjection({ identity, attempts: [] });
        },
      }),
    );
    void read();
    return () => {
      active = false;
      subscriptions.forEach((subscription) => subscription.unsubscribe());
    };
  }, [
    state,
    serverId,
    actorId,
    workspaceId,
    databaseId,
    taskId,
    identity,
    revision,
  ]);
  return projection?.identity === identity ? projection.attempts : [];
}

export function ContextRecoveryMenu({
  attempts,
  onOpen,
}: {
  attempts: readonly ContextDocumentsAttempt[];
  onOpen: (attempt: ContextDocumentsAttempt) => void;
}) {
  const t = useI18n();
  const retained = attempts.filter((attempt) => !attempt.gone);
  if (!retained.length) return null;
  return (
    <MenuSub
      items={
        <MenuPanel>
          {retained.map((attempt) => (
            <MenuItem
              key={`${attempt.product ?? "context"}:${attempt.input.requestId}`}
              onSelect={() => onOpen(attempt)}
            >
              {attempt.product === "documentReview"
                ? t["com.myoxus.database.review.details"]()
                : attempt.product === "taskHandover"
                  ? t["com.myoxus.database.handover.details"]()
                  : attempt.product === "taskMaintenance"
                    ? t["com.myoxus.database.maintenance.details"]()
                    : t["com.myoxus.database.setup.check"]()}
            </MenuItem>
          ))}
        </MenuPanel>
      }
    >
      {t["com.myoxus.database.automation.runs-title"]()}
    </MenuSub>
  );
}
