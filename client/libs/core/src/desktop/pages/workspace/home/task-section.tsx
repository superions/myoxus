// SPDX-License-Identifier: AGPL-3.0-or-later

import { TaskCoverageNotice } from "@myoxus/core/modules/database/tasks/managed-feedback";

import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { classifyDatabaseError } from "@myoxus/core/modules/database/route-state";
import { presentTaskDue } from "@myoxus/core/modules/database/tasks/due";
import { useWorkspaceTasks } from "@myoxus/core/modules/database/tasks/use-workspace-tasks";
import { GuardService } from "@myoxus/core/modules/permissions";
import type { WorkspaceDashboardDashletSize } from "@myoxus/core/modules/server";
import { isWorkspaceTagColorRole } from "@myoxus/core/modules/tag";
import {
  AssistantActionKind,
  AssistantContext,
  AssistantControlKind,
  AssistantGroupRole,
  AssistantTaskSummaryValue,
} from "@myoxus/graphql";
import { useAssistantPresentation } from "@myoxus/core/modules/database/presentation/use-assistant-presentation";
import {
  assistantText,
  assistantVisible,
} from "@myoxus/core/modules/database/presentation/values";
import { useI18n } from "@myoxus/i18n";
import { ListChecksIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  EmptyState,
  Group,
  Loading,
  MyoxusText,
  NavigationLink,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import { taskInventoryPresentation } from "@myoxus/core/modules/database/presentation/task-inventory";
import { AssistantGroupArtwork } from "@myoxus/core/modules/database/presentation/renderer";
import { Fragment, useEffect, useMemo, type Ref } from "react";

import { getDashboardDocumentLimit } from "./dashboard-layout";
import { DashboardSection } from "./section";

/** Home previews the canonical Mine/open inventory; creation and editing stay
 * in the shared Tasks route. Failed reads never become healthy empty counts.
 */
export function DashboardTaskSection({
  size,
  onOpenTasks,
  onOpenTask,
  onNewTask,
  newTaskRef,
  openTasksRef,
  onPreviewReady,
}: {
  size: WorkspaceDashboardDashletSize;
  onOpenTasks: () => void;
  onOpenTask: (databaseId: string, rowId: string) => void;
  onNewTask: () => void;
  newTaskRef?: Ref<HTMLButtonElement>;
  openTasksRef?: Ref<HTMLButtonElement>;
  onPreviewReady?: () => void;
}) {
  const t = useI18n();
  const { timezone } = useRegionalPreferences();
  const presentation = useAssistantPresentation(AssistantContext.TaskHome);
  const descriptor = presentation.descriptor;
  const configured = taskInventoryPresentation(descriptor, {});
  const actions =
    descriptor?.presentation.steps
      .flatMap((step) => step.actions)
      .filter((action) =>
        assistantVisible(action.visibleWhen, configured.answers),
      ) ?? [];
  const allowsCreate = actions.some(
    (action) => action.action === AssistantActionKind.CreateTask,
  );
  // The native Task inventory defaults to Mine/open; Home adds no filter policy.
  const input = useMemo(() => ({ timeZone: timezone }), [timezone]);
  const {
    page,
    error,
    isLoading,
    isValidating,
    availability,
    mutate,
    live,
    retryLive,
  } = useWorkspaceTasks(input, getDashboardDocumentLimit(size));
  const canCreate = useLiveData(
    useService(GuardService).can$("Workspace_CreateDoc"),
  );
  const failure = error ? classifyDatabaseError(error) : null;
  const available = availability.status === "available";
  const ready =
    available && Boolean(descriptor) && !error && !isLoading && !!page;
  const previewSettled =
    !available ||
    (!presentation.isLoading && (!descriptor || (!isLoading && !isValidating)));
  useEffect(() => {
    if (previewSettled) onPreviewReady?.();
  }, [previewSettled, page?.rows, onPreviewReady]);
  const retry = () => {
    retryLive();
    void mutate();
  };

  const renderInventory = (columns: readonly AssistantTaskSummaryValue[]) =>
    !available ? (
      <EmptyState title={t["com.myoxus.database.server-backed-only.title"]()} />
    ) : error ? (
      <Notice
        tone="warning"
        title={
          failure === "forbidden"
            ? t["com.myoxus.database.embed.forbidden"]()
            : failure === "offline"
              ? t["com.myoxus.database.embed.offline"]()
              : t["com.myoxus.database.tasks.load-failed"]()
        }
      >
        <Button variant="secondary" onClick={retry}>
          {t.Retry()}
        </Button>
      </Notice>
    ) : !descriptor ? (
      <Notice tone="warning">
        <Button onClick={() => void presentation.mutate()}>{t.Retry()}</Button>
      </Notice>
    ) : isLoading || !page ? (
      <Loading />
    ) : !page.rows.length ? (
      <EmptyState title={t["com.myoxus.database.tasks.none-assigned-open"]()} />
    ) : (
      <Stack gap={0}>
        {page.rows.map((row) => {
          const due = presentTaskDue(row.due, t.language, timezone);
          return (
            <NavigationLink
              component="button"
              type="button"
              key={row.rowId}
              label={
                columns.includes(AssistantTaskSummaryValue.Title) ? (
                  <MyoxusText component="span" lineClamp={2} title={row.title}>
                    {row.title}
                  </MyoxusText>
                ) : null
              }
              description={
                <Group>
                  {columns
                    .filter(
                      (column) => column !== AssistantTaskSummaryValue.Title,
                    )
                    .map((column) => (
                      <Fragment key={column}>
                        {column === AssistantTaskSummaryValue.Destination ? (
                          <MyoxusText
                            component="span"
                            lineClamp={1}
                            title={row.projectTitle}
                            tone="secondary"
                          >
                            {row.projectTitle}
                          </MyoxusText>
                        ) : null}
                        {column === AssistantTaskSummaryValue.Status ? (
                          row.status ? (
                            <Badge
                              truncate
                              title={row.status.name}
                              tagColorRole={
                                isWorkspaceTagColorRole(row.status.colorRole)
                                  ? row.status.colorRole
                                  : undefined
                              }
                            >
                              {row.status.name}
                            </Badge>
                          ) : null
                        ) : null}
                        {column === AssistantTaskSummaryValue.Due &&
                        row.hasDue &&
                        due?.label ? (
                          <Group>
                            <MyoxusText component="span" tone="secondary">
                              {due.label}
                            </MyoxusText>
                            {due?.overdue ? (
                              <Badge tone="warning">
                                {t["com.myoxus.database.progress.overdue"]()}
                              </Badge>
                            ) : null}
                          </Group>
                        ) : null}
                      </Fragment>
                    ))}
                </Group>
              }
              onClick={() => onOpenTask(row.databaseId, row.rowId)}
              data-myoxus-ui-role="workspace-home-task-row"
              data-task-id={row.rowId}
            />
          );
        })}
      </Stack>
    );
  return (
    <DashboardSection
      title={
        (descriptor ? assistantText(descriptor.name, t.language) : undefined) ??
        t["com.myoxus.database.progress.tasks"]()
      }
      icon={<ListChecksIcon aria-hidden />}
      action={{
        label: t["com.myoxus.database.tasks.open-overview"](),
        onClick: onOpenTasks,
        ref: openTasksRef,
      }}
      uiRole="workspace-home-tasks"
    >
      <Stack>
        {presentation.isLoading ? (
          <Loading />
        ) : !descriptor ? (
          <Notice tone="warning">
            <Button onClick={() => void presentation.mutate()}>
              {t.Retry()}
            </Button>
          </Notice>
        ) : (
          configured.groups.map((group) => (
            <Stack key={group.id}>
              {group.title ? (
                <MyoxusText>
                  {assistantText(group.title, t.language)}
                </MyoxusText>
              ) : null}
              <AssistantGroupArtwork
                descriptor={descriptor}
                stepId={descriptor.presentation.steps[0]?.id}
                groupId={group.id}
                server={presentation.owner.server}
              />
              {group.role === AssistantGroupRole.Inventory
                ? renderInventory(
                    group.controls.flatMap((control) =>
                      control.kind === AssistantControlKind.TaskSummary &&
                      control.value
                        ? [control.value]
                        : [],
                    ),
                  )
                : null}
            </Stack>
          ))
        )}
        {ready && !live ? (
          <Notice
            tone="warning"
            title={t["com.myoxus.database.realtime.unavailable"]()}
          >
            <Button variant="secondary" onClick={retry}>
              {t.Retry()}
            </Button>
          </Notice>
        ) : null}
        <Group justify="space-between">
          {ready ? (
            <Group>
              <MyoxusText tone="secondary">
                {page.totalCount === 1
                  ? t["com.myoxus.database.tasks.count_one"]({
                      count: page.totalCount,
                    })
                  : t["com.myoxus.database.tasks.count_other"]({
                      count: page.totalCount,
                    })}
              </MyoxusText>
              <TaskCoverageNotice
                coverageComplete={page.coverageComplete}
                unavailableProjects={page.unavailableProjects}
                onRetry={retry}
              />
            </Group>
          ) : null}
          {actions.some(
            (action) => action.action === AssistantActionKind.Refresh,
          ) && ready ? (
            <Button variant="secondary" onClick={retry}>
              {t.Retry()}
            </Button>
          ) : null}
          {available && failure !== "forbidden" && canCreate && allowsCreate ? (
            <Button ref={newTaskRef} variant="secondary" onClick={onNewTask}>
              {t["com.myoxus.database.tasks.new"]()}
            </Button>
          ) : null}
        </Group>
      </Stack>
    </DashboardSection>
  );
}
