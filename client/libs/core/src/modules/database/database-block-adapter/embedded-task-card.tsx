// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { isWorkspaceTagColorRole } from "@myoxus/core/modules/tag";
import {
  DatabaseStatusGroup,
  DatabaseTaskBlockingState,
  type DatabaseTaskSummaryFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  EditIcon,
  OpenInNewIcon,
  LinkIcon,
  UserIcon,
  CloseIcon,
  ChevronDownIcon,
} from "@myoxus/icons/react";
import type { FrameworkProvider } from "@myoxus/infra";
import {
  Badge,
  Card,
  Grid,
  Group,
  IconButton,
  MyoxusText,
  Stack,
  Button,
} from "@myoxus/ui-facade";
import { useState } from "react";
import { managedTaskFields } from "../managed";
import { getCellValue } from "../model";
import { useTaskBlockingRead } from "../row-detail/task-blocking";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import { taskOptionDisplayName } from "../presentation/task-labels";
import {
  TaskDetailNavigationContext,
  useTaskDetailNavigation,
} from "../row-detail/task-navigation";
import { TaskDetail } from "../tasks/task-detail";
import { EmbeddedTaskFields } from "../tasks/embedded-task-fields";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import { presentTaskDue } from "../tasks/due";
import type { TaskReferenceTarget } from "../tasks/task-reference-insertion";
import { taskReferenceBatch } from "./task-reference-batch";

export function EmbeddedTaskCard({
  task,
  framework,
  trashed,
  readonly,
  onOpen,
}: {
  task: DatabaseTaskSummaryFragment;
  framework: FrameworkProvider;
  trashed: boolean;
  readonly: boolean;
  onOpen?: (target: TaskReferenceTarget) => void;
}) {
  const t = useI18n();
  const owner = useTaskIdentity();
  const [expanded, setExpanded] = useState(false);
  const workbench = framework.get(WorkbenchService).workbench;
  const openTask = (databaseId: string, rowId: string) => {
    const lifecycle =
      task.status?.group === DatabaseStatusGroup.Complete ||
      task.status?.group === DatabaseStatusGroup.Archived
        ? "Closed"
        : "Open";
    workbench.open(
      `/tasks?${new URLSearchParams({ view: "kanban", scope: "All", lifecycle, databaseId, rowId, projectId: databaseId })}`,
      { at: "active" },
    );
  };
  const { navigation } = useTaskDetailNavigation(
    owner.identity,
    task.rowId,
    (rowId) => openTask(task.databaseId, rowId),
  );
  const open = () =>
    navigation.requestLeave?.(() => {
      if (onOpen)
        onOpen({
          workspaceId: task.workspaceId,
          databaseId: task.databaseId,
          rowId: task.rowId,
        });
      else openTask(task.databaseId, task.rowId);
    });
  const due = presentTaskDue(
    task.due,
    t.language,
    useRegionalPreferences().timezone,
  );
  const refresh = async () => {
    await taskReferenceBatch(framework).refresh();
  };
  return (
    <TaskDetailNavigationContext.Provider value={navigation}>
      <Grid>
        <Grid.Col span={6}>
          <TaskDetail
            databaseId={task.databaseId}
            rowId={task.rowId}
            readonly={readonly || !task.canEdit || trashed}
            onChanged={refresh}
            onOpenTask={openTask}
            onOpenDoc={(docId) => workbench.openDoc(docId, { at: "new-tab" })}
            onOpenProject={(databaseId) =>
              workbench.open(`/databases/${databaseId}`, { at: "new-tab" })
            }
            embedded={(fields) => {
              const bindings = managedTaskFields(fields.record);
              const dependencyField = bindings?.get("task.dependencies");
              const dependencies = dependencyField
                ? (getCellValue(fields.row, dependencyField.id)?.value
                    .relationTargets ?? [])
                : [];
              // Native SQL fields own their caret independently of the document's Yjs range.
              return (
                <Card
                  withBorder
                  padding="default"
                  data-testid="embedded-task-card"
                  data-range-sync-exclude="true"
                  onKeyDown={(event) => {
                    if (event.key !== "Tab") event.stopPropagation();
                  }}
                  onCopy={(event) => event.stopPropagation()}
                  onCut={(event) => event.stopPropagation()}
                  onPaste={(event) => event.stopPropagation()}
                  data-row-id={task.rowId}
                  data-database-id={task.databaseId}
                >
                  <Stack>
                    <Stack
                      onDoubleClick={(event) => {
                        // The Page's outer editable root is not a header control.
                        if (
                          !event.currentTarget.contains(
                            (event.target as Element).closest(
                              'button,input,textarea,[contenteditable="true"]',
                            ),
                          )
                        )
                          open();
                      }}
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Group>
                          {trashed ? <Badge>{t.Trash()}</Badge> : null}
                          {task.status ? (
                            <Badge
                              tagColorRole={
                                isWorkspaceTagColorRole(task.status.colorRole)
                                  ? task.status.colorRole
                                  : undefined
                              }
                            >
                              {taskOptionDisplayName(
                                t,
                                "task.status",
                                task.status.id,
                              )}
                            </Badge>
                          ) : null}
                        </Group>
                        <Group wrap="nowrap">
                          <IconButton
                            icon={
                              expanded ? (
                                <CloseIcon />
                              ) : readonly || !task.canEdit || trashed ? (
                                <ChevronDownIcon />
                              ) : (
                                <EditIcon />
                              )
                            }
                            tooltip={
                              expanded
                                ? t["com.myoxus.peek-view-controls.close"]()
                                : readonly || !task.canEdit || trashed
                                  ? t["com.myoxus.database.row.open-details"]()
                                  : t.Edit()
                            }
                            aria-expanded={expanded}
                            onClick={() =>
                              navigation.requestLeave?.(() =>
                                setExpanded(!expanded),
                              )
                            }
                          />
                          <IconButton
                            icon={<OpenInNewIcon />}
                            tooltip={t[
                              "com.myoxus.database.tasks.open-kanban"
                            ]()}
                            onClick={open}
                          />
                        </Group>
                      </Group>
                      <MyoxusText typographySlot="card-title">
                        {task.title}
                      </MyoxusText>
                      {task.descriptionPreview && !expanded ? (
                        <MyoxusText tone="secondary" lineClamp={2}>
                          {task.descriptionPreview}
                        </MyoxusText>
                      ) : null}
                      <Group>
                        <Group
                          gap="xs"
                          aria-label={t[
                            "com.myoxus.database.property.assignees"
                          ]()}
                        >
                          <UserIcon aria-hidden />
                          <MyoxusText
                            tone="secondary"
                            typographySlot="body-small"
                          >
                            {task.assignees
                              .map((actor) => actor.name)
                              .join(", ") ||
                              t["com.myoxus.database.kanban.unassigned"]()}
                          </MyoxusText>
                        </Group>
                        {task.hasDue && due ? (
                          <MyoxusText
                            tone="secondary"
                            typographySlot="body-small"
                          >
                            {due.label}
                          </MyoxusText>
                        ) : null}
                        {task.hasPriority && task.priority ? (
                          <Badge>
                            {taskOptionDisplayName(
                              t,
                              "task.priority",
                              task.priority.id,
                            )}
                          </Badge>
                        ) : null}
                      </Group>
                      {dependencies.length ? (
                        <Group
                          gap="xs"
                          aria-label={t["com.myoxus.common.dependencies"]()}
                        >
                          <LinkIcon aria-hidden />
                          <MyoxusText
                            tone="secondary"
                            typographySlot="body-small"
                            lineClamp={2}
                          >
                            {dependencies
                              .map((target) =>
                                target.redacted || target.deleted
                                  ? t["com.myoxus.template-list.unavailable"]()
                                  : target.title,
                              )
                              .join(", ")}
                          </MyoxusText>
                        </Group>
                      ) : null}
                      {bindings?.get("task.blockedBy") ? (
                        <TaskCardBlockers
                          record={fields.record}
                          row={fields.row}
                          onOpen={open}
                        />
                      ) : null}
                    </Stack>
                    {expanded ? <EmbeddedTaskFields {...fields} /> : null}
                  </Stack>
                </Card>
              );
            }}
          />
        </Grid.Col>
      </Grid>
    </TaskDetailNavigationContext.Provider>
  );
}

/** Activity comes from the existing authorized prerequisite projection, never
 * from a client guess based on another card's status or a locally copied edge.
 */
function TaskCardBlockers({
  record,
  row,
  onOpen,
}: {
  record: DatabaseRecord;
  row: DatabaseRowRecord;
  onOpen: () => void;
}) {
  const t = useI18n();
  const read = useTaskBlockingRead(record, row, "blockedBy");
  const label = t["com.myoxus.database.task-blocking.blocked-by"]();
  const data = read.isCurrent() ? read.data : undefined;
  if (!data && !read.error) return null;
  if (
    read.error ||
    !data?.available ||
    data.fieldId !== managedTaskFields(record)?.get("task.blockedBy")?.id
  )
    return (
      <MyoxusText tone="warning" typographySlot="body-small">
        {label}: {t["com.myoxus.template-list.unavailable"]()}
      </MyoxusText>
    );
  return data.rows.length ? (
    <Stack gap="xs" aria-label={label}>
      {data.rows.slice(0, 2).map((entry) => (
        <Group key={entry.rowId} gap="xs">
          <LinkIcon aria-hidden />
          <MyoxusText typographySlot="body-small" lineClamp={1}>
            {entry.task?.title ?? t["com.myoxus.template-list.unavailable"]()}
          </MyoxusText>
          <Badge
            tone={
              entry.state === DatabaseTaskBlockingState.Inactive
                ? "neutral"
                : "warning"
            }
          >
            {entry.state === DatabaseTaskBlockingState.Active
              ? t["com.myoxus.database.task-blocking.active"]()
              : entry.state === DatabaseTaskBlockingState.Inactive
                ? t["com.myoxus.database.task-blocking.inactive"]()
                : t["com.myoxus.database.task-blocking.unresolved"]()}
          </Badge>
        </Group>
      ))}
      {data.nextCursor || data.rows.length > 2 ? (
        <Button variant="plain" onClick={onOpen}>
          {t["com.myoxus.database.row.open-details"]()}
        </Button>
      ) : null}
    </Stack>
  ) : null;
}
