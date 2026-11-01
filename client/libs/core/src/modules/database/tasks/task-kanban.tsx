// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { LinkIcon } from "@myoxus/icons/react";
import {
  Badge,
  Group,
  KanbanBoard,
  MyoxusText,
  Tooltip,
  type KanbanBoardProps,
  type KanbanColumnModel,
  type KanbanCardModel,
} from "@myoxus/ui-facade";

import { taskOptionDisplayName } from "../presentation/task-labels";
import { presentTaskDue } from "./due";
import type { WorkspaceTaskPage } from "./use-workspace-task-board";
import type { useTaskStatusAction } from "./use-task-status-action";

export const taskCardId = (databaseId: string, rowId: string) =>
  JSON.stringify([databaseId, rowId]);
type Task = WorkspaceTaskPage["rows"][number];
type TaskColumn = Omit<KanbanColumnModel, "cards"> & {
  cards: KanbanCardModel[];
};

/** Content and native identities only; the shared board owns all interaction,
 * framing, scrolling and focus. No Task status is inferred from a status group.
 */
export function TaskKanban({
  page,
  timeZone,
  defaultDatabaseId,
  display,
  selected,
  focusRequest,
  onOpenTask,
  onSelectionTargetChange,
  statusAction,
}: {
  page: WorkspaceTaskPage;
  timeZone: string;
  defaultDatabaseId?: string;
  display: { assignees: boolean; priority: boolean };
  selected?: string;
  focusRequest?: KanbanBoardProps["focusRequest"];
  onOpenTask: (task: Task, trigger: HTMLElement) => void;
  onSelectionTargetChange?: KanbanBoardProps["onSelectionTargetChange"];
  statusAction: ReturnType<typeof useTaskStatusAction>;
}) {
  const t = useI18n();
  const movementReady =
    statusAction.canEdit && !statusAction.pending && !statusAction.uncertain;
  const byId = new Map(
    page.rows.map((row) => [taskCardId(row.databaseId, row.rowId), row]),
  );
  const columns: TaskColumn[] = page.statusOptions.map((option) => ({
    id: `status:${option.id}`,
    label: taskOptionDisplayName(t, "task.status", option.id),
    cards: [],
    receive: { enabled: Boolean(movementReady) },
    add: { enabled: false },
    rename: { enabled: false },
    reorder: { enabled: false },
    remove: { enabled: false },
  }));
  const unknown: TaskColumn = {
    id: "status-unavailable",
    label: t["com.myoxus.database.tasks.status-unavailable"](),
    cards: [],
    receive: { enabled: false },
    add: { enabled: false },
    rename: { enabled: false },
    reorder: { enabled: false },
    remove: { enabled: false },
  };
  for (const row of page.rows) {
    const column =
      columns.find(
        (column) => row.status && column.id === `status:${row.status.id}`,
      ) ?? unknown;
    const due = presentTaskDue(row.due, t.language, timeZone);
    const subtask = row.isSubtask
      ? t["com.myoxus.database.tasks.subtask"]()
      : undefined;
    const blocking =
      (row.blockers?.activeCount ?? 0) > 0 ||
      (row.blockers?.unresolvedCount ?? 0) > 0;
    const link = blocking
      ? t["com.myoxus.database.task-blocking.blocked-by"]()
      : row.hasDependencies
        ? t["com.myoxus.database.tasks.related"]()
        : undefined;
    const project =
      defaultDatabaseId && row.databaseId !== defaultDatabaseId
        ? row.projectTitle
        : undefined;
    column.cards.push({
      id: taskCardId(row.databaseId, row.rowId),
      columnId: column.id,
      label: row.title,
      description: [
        row.title,
        subtask,
        link,
        row.descriptionPreview,
        project,
        due?.label,
      ]
        .filter(Boolean)
        .join("; "),
      defaultActions: false,
      open: { enabled: true },
      move: {
        enabled: Boolean(
          movementReady &&
          row.canEdit &&
          !row.deletedAt &&
          column !== unknown &&
          row.status,
        ),
      },
      rename: { enabled: false },
      remove: { enabled: false },
      density: "default",
      testId: "task-kanban-card",
      dataAttributes: {
        "data-row-id": row.rowId,
        "data-database-id": row.databaseId,
      },
      content: (
        <>
          {subtask || link ? (
            <Group>
              {subtask ? (
                <Tooltip content={subtask}>
                  <Badge title={subtask}>
                    {t["com.myoxus.database.tasks.subtask-short"]()}
                  </Badge>
                </Tooltip>
              ) : null}
              {link ? (
                <Tooltip content={link}>
                  <MyoxusText
                    component="span"
                    tone={blocking ? "warning" : "secondary"}
                    title={link}
                  >
                    <LinkIcon aria-hidden />
                  </MyoxusText>
                </Tooltip>
              ) : null}
            </Group>
          ) : null}
          {row.descriptionPreview ? (
            <MyoxusText tone="secondary" lineClamp={2}>
              {row.descriptionPreview}
            </MyoxusText>
          ) : null}
          {project || due ? (
            <Group justify="space-between">
              {project ? <Badge>{project}</Badge> : null}
              {due ? (
                <MyoxusText tone="secondary" typographySlot="body-small">
                  {due.label}
                </MyoxusText>
              ) : null}
            </Group>
          ) : null}
          {display.assignees && row.assignees.length ? (
            <MyoxusText tone="secondary" typographySlot="body-small">
              {row.assignees.map((user) => user.name).join(", ")}
            </MyoxusText>
          ) : null}
          {display.priority && row.priority ? (
            <MyoxusText tone="secondary" typographySlot="body-small">
              {taskOptionDisplayName(t, "task.priority", row.priority.id)}
            </MyoxusText>
          ) : null}
        </>
      ),
    });
  }
  if (unknown.cards.length) columns.push(unknown);
  return (
    <KanbanBoard
      aria-label={t["com.myoxus.database.view.kanban"]()}
      data-testid="tasks-kanban"
      appearance="surface"
      activation="open"
      order="external"
      keyboardMovement="adjacent-column"
      columns={columns}
      renderLabel={(label) => (
        <MyoxusText component="span" lineClamp={2}>
          {label}
        </MyoxusText>
      )}
      selection={selected ? { cardId: selected } : undefined}
      focusRequest={focusRequest}
      onSelectionTargetChange={onSelectionTargetChange}
      readonly={!statusAction.canEdit}
      onMoveCard={async (move) => {
        const row = byId.get(move.cardId);
        const option = page.statusOptions.find(
          (option) => `status:${option.id}` === move.toColumnId,
        );
        if (
          move.fromColumnId === move.toColumnId ||
          !movementReady ||
          !row?.canEdit ||
          row.deletedAt ||
          !row.status ||
          !option ||
          !page.statusOptions.some((option) => option.id === row.status?.id)
        )
          return false;
        return (await statusAction.change(row, option.id)) === "applied";
      }}
      onOpenCard={(id, trigger) => {
        const row = byId.get(id);
        if (row) onOpenTask(row, trigger);
      }}
      labels={{
        actions: t["com.myoxus.database.row.menu"](),
        addCard: (column) =>
          t["com.myoxus.database.kanban.add-task-to-column"]({ column }),
        addColumn: t["com.myoxus.database.kanban.add-column"](),
        cardCount: (count) => count.toLocaleString(t.language),
        dragCard: () => t["com.myoxus.database.kanban.drag-row"](),
        dragColumn: (label) => label,
        deleteCard: (label) => label,
        deleteColumn: (label) => label,
        emptyColumn: "",
        openCard: () => t["com.myoxus.database.row.open-details"](),
        movedCard: (label, _from, to) => `${label}: ${to}`,
        movedColumn: (label, to) => `${label}: ${to}`,
      }}
    />
  );
}
