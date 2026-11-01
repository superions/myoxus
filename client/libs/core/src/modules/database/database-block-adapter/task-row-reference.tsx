// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { isWorkspaceTagColorRole } from "@myoxus/core/modules/tag";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  DatabaseTaskReferenceState,
  type DatabaseTaskSummaryFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import {
  Badge,
  Button,
  Group,
  Loading,
  MyoxusText,
  Stack,
  SelectableCardRow,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { presentTaskDue } from "../tasks/due";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { TaskReferenceTarget } from "../tasks/task-reference-insertion";
import { taskReferenceBatch } from "./task-reference-batch";

export function TaskReferenceSummary({
  task,
  trashed,
  onOpen,
}: {
  task: DatabaseTaskSummaryFragment;
  trashed?: boolean;
  onOpen: () => void;
}) {
  const t = useI18n();
  const due = presentTaskDue(
    task.due,
    t.language,
    useRegionalPreferences().timezone,
  );
  const assignees = task.hasAssignees
    ? task.assignees
        .map((actor) => actor.name)
        .filter(Boolean)
        .join(", ")
    : "";
  return (
    <SelectableCardRow type="button" aria-label={task.title} onClick={onOpen}>
      <Stack>
        <MyoxusText>{task.title}</MyoxusText>
        <MyoxusText tone="secondary">{task.projectTitle}</MyoxusText>
        {trashed || task.status || assignees || (task.hasDue && due) ? (
          <Group>
            {trashed ? <Badge>{t.Trash()}</Badge> : null}
            {task.status ? (
              <Group
                role="group"
                aria-label={t["com.myoxus.database.field.type.status"]()}
              >
                <Badge
                  tagColorRole={
                    isWorkspaceTagColorRole(task.status.colorRole)
                      ? task.status.colorRole
                      : undefined
                  }
                >
                  {task.status.name}
                </Badge>
              </Group>
            ) : null}
            {assignees ? (
              <Group
                role="group"
                aria-label={t["com.myoxus.database.property.assignees"]()}
              >
                <MyoxusText>{assignees}</MyoxusText>
              </Group>
            ) : null}
            {task.hasDue && due ? (
              <Group
                role="group"
                aria-label={t["com.myoxus.database.property.due"]()}
              >
                <MyoxusText>{due.label}</MyoxusText>
              </Group>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </SelectableCardRow>
  );
}

export function TaskRowReference({
  framework,
  target: suppliedTarget,
  onOpen,
}: {
  framework: FrameworkProvider;
  target: TaskReferenceTarget;
  onOpen?: (target: TaskReferenceTarget) => void;
}) {
  const owner = useTaskIdentity();
  const t = useI18n();
  const batch = taskReferenceBatch(framework);
  const { workspaceId, databaseId, rowId } = suppliedTarget;
  const target = useMemo(
    () => ({ workspaceId, databaseId, rowId }),
    [workspaceId, databaseId, rowId],
  );
  const subscribe = useCallback(
    (listener: () => void) => batch.attach(owner, target, listener),
    [batch, owner, target],
  );
  const snapshot = useCallback(
    () => batch.snapshot(owner, target),
    [batch, owner, target],
  );
  const read = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (read.status === "loading") return <Loading />;
  if (
    read.status !== "ready" ||
    read.reference.state === DatabaseTaskReferenceState.Unavailable ||
    !read.reference.task
  )
    return (
      <Stack>
        <MyoxusText>
          {read.status === "offline"
            ? t["com.myoxus.database.embed.offline"]()
            : t["com.myoxus.database.row_detail.unavailable"]()}
        </MyoxusText>
        <Button variant="secondary" onClick={() => void batch.refresh()}>
          {t.Retry()}
        </Button>
      </Stack>
    );
  return (
    <TaskReferenceSummary
      task={read.reference.task}
      trashed={read.reference.state === DatabaseTaskReferenceState.Trashed}
      onOpen={() => {
        const task = read.reference.task!;
        if (onOpen) {
          onOpen({
            workspaceId: task.workspaceId,
            databaseId: task.databaseId,
            rowId: task.rowId,
          });
          return;
        }
        framework
          .get(WorkbenchService)
          .workbench.open(
            `/databases/${read.reference.task!.databaseId}?${new URLSearchParams({ rowId: target.rowId })}`,
            { at: "active" },
          );
      }}
    />
  );
}
