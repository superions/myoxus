// SPDX-License-Identifier: AGPL-3.0-or-later

import { taskOptionDisplayName } from "@myoxus/core/modules/database/presentation/task-labels";
import {
  ContextDocumentAssistance,
  ContextDocumentTaskMenu,
} from "@myoxus/core/modules/database/assistance/context-documents";
import { taskAssistanceDestination } from "@myoxus/core/modules/database/assistance/task-container-target";
import { DatabaseWorkbenchContextSurface } from "@myoxus/core/modules/database/workbench-context";
import { DatabaseAutomationsPanel } from "@myoxus/core/modules/database/workbench-context/database-automations";
import {
  PublicUserService,
  UserPreferencesService,
} from "@myoxus/core/modules/server";
import { AssistancePreference } from "@myoxus/core/modules/server/views/assistance-preference";
import { TaskCoverageNotice } from "@myoxus/core/modules/database/tasks/managed-feedback";

import { MemberSelector } from "@myoxus/core/components/member-selector";
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { classifyDatabaseError } from "@myoxus/core/modules/database/route-state";
import { presentTaskDue } from "@myoxus/core/modules/database/tasks/due";
import { TaskBlockerIndicator } from "@myoxus/core/modules/database/tasks/task-blocker-indicator";
import {
  TaskKanban,
  taskCardId,
} from "@myoxus/core/modules/database/tasks/task-kanban";
import { useWorkspaceTaskBoard } from "@myoxus/core/modules/database/tasks/use-workspace-task-board";
import {
  useTaskDestinations,
  useTaskIdentity,
  useWorkspaceTasks,
} from "@myoxus/core/modules/database/tasks/use-workspace-tasks";
import {
  consumeTaskCreationIntent,
  taskCreationReturnRoute,
  taskHomeReturnIntent,
  type TaskCreationOrigin,
} from "@myoxus/core/modules/database/tasks/creation-intent";
import { NewTaskModal } from "@myoxus/core/modules/database/tasks/new-task-modal";
import {
  TaskDetailNavigationContext,
  useTaskDetailNavigation,
} from "@myoxus/core/modules/database/row-detail/task-navigation";
import { TaskDetail } from "@myoxus/core/modules/database/tasks/task-detail";
import { TaskRecurrenceManager } from "@myoxus/core/modules/recurrence/task-recurrence-manager";
import { inferOpenMode } from "@myoxus/core/utils";
import { useTaskStatusAction } from "@myoxus/core/modules/database/tasks/use-task-status-action";
import { DatabaseConflictProvider } from "@myoxus/core/modules/database/presence";
import { GuardService } from "@myoxus/core/modules/permissions";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
  WorkbenchLink,
  ViewService,
  ViewContextSurface,
  WorkbenchToolLayoutBinding,
  useIsActiveView,
} from "@myoxus/core/modules/workbench";
import {
  AssistantGroupRole,
  AssistantActionKind,
  AssistantContext,
  AssistantControlKind,
  AssistantTaskSummaryValue,
  AssistantTaskFilter,
  AssistantInputTarget,
  DatabaseTaskScope,
  DatabaseTaskLifecycle,
  DatabaseTaskDuePreset,
  DatabaseTaskSort,
  DatabaseStatusGroup,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  CloseIcon,
  FilterIcon,
  ListChecksIcon,
  AllDocsListViewIcon,
  DatabaseKanbanViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  WorkbenchContextScrollRoot,
  Checkbox,
  Button,
  EmptyState,
  FilterBar,
  FilterChip,
  FilterChipTrigger,
  IconButton,
  Menu,
  MenuSub,
  MenuSeparator,
  MenuSectionLabel,
  Group,
  Badge,
  Box,
  HeaderMenuButton,
  Loading,
  MenuPanel,
  MenuItem,
  MyoxusText,
  Notice,
  notify,
  PageContentRail,
  SearchInput,
  Scrollable,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableScrollContainer,
  WorkbenchHeaderFrame,
  WorkbenchHeaderContextPath,
  ViewSwitcher,
  type KanbanBoardProps,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAssistantPresentation } from "@myoxus/core/modules/database/presentation/use-assistant-presentation";
import {
  taskInventoryDisplay,
  taskInventoryPresentation,
} from "@myoxus/core/modules/database/presentation/task-inventory";
import {
  assistantText,
  assistantVisible,
} from "@myoxus/core/modules/database/presentation/values";
import { useSearchParams } from "react-router";

const TASK_VIEW_FAMILIES = ["database"] as const;

function TasksPage() {
  const t = useI18n();
  const assistanceOwner = useTaskIdentity();
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const isActiveView = useIsActiveView();
  const toolLayout = useLiveData(view.toolLayout$);
  const canCreate = useLiveData(
    useService(GuardService).can$("Workspace_CreateDoc"),
  );
  const [params] = useSearchParams();
  const kanban = params.get("view") === "kanban";
  const [boardFocus, setBoardFocus] =
    useState<KanbanBoardProps["focusRequest"]>();
  const inventoryScroll = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef({ list: 0, kanban: 0 });
  useEffect(() => {
    if (inventoryScroll.current)
      inventoryScroll.current.scrollTop =
        scrollPositions.current[kanban ? "kanban" : "list"];
  }, [kanban]);
  const publicUserService = useService(PublicUserService);
  const assigneeId = params.get("assigneeId");
  const assignee = useLiveData(publicUserService.publicUser$(assigneeId ?? ""));
  useEffect(() => {
    // A filter's selected person remains identifiable even with no matching rows.
    if (assigneeId) publicUserService.revalidate(assigneeId);
  }, [assigneeId, publicUserService]);
  const setParams = useCallback(
    (next: URLSearchParams) => {
      const query = next.toString();
      view.replace({
        ...view.location$.value,
        pathname: "/tasks",
        search: query ? `?${query}` : "",
      });
    },
    [view],
  );
  const presentation = useAssistantPresentation(AssistantContext.TaskInventory);
  const descriptor = presentation.descriptor;
  const configured = taskInventoryPresentation(descriptor, {
    [AssistantInputTarget.TaskScope]: params.get("scope"),
    [AssistantInputTarget.TaskLifecycle]: params.get("lifecycle"),
  });
  const display = taskInventoryDisplay(params.getAll("display"));
  const controls = configured.controls;
  const filters = controls
    .filter(
      (control) =>
        control.kind === AssistantControlKind.TaskFilter && control.filter,
    )
    .map((control) => control.filter!);
  const filterKey = filters.join(",");
  const activeFilters = useMemo(
    () => new Set(filterKey.split(",")),
    [filterKey],
  );
  const actions =
    descriptor?.presentation.steps
      .flatMap((step) => step.actions)
      .filter((action) =>
        assistantVisible(action.visibleWhen, configured.answers),
      ) ?? [];
  const allowsCreate = actions.some(
    (action) => action.action === AssistantActionKind.CreateTask,
  );
  const nativeChoice = <T extends string>(
    values: T[],
    choice: string | null | undefined,
  ) => values.find((value) => value.toLowerCase() === choice?.toLowerCase());
  const sourceChoices = <T extends string>(
    target: AssistantInputTarget,
    values: T[],
    testId: string,
  ) => {
    const input = descriptor?.inputs.find((input) => input.target === target);
    return (
      input?.choices.flatMap((choice) => {
        const value = nativeChoice(
          values,
          choice.value.choice ?? choice.value.text,
        );
        return value
          ? [
              {
                value,
                label: assistantText(choice.label, t.language),
                testId: `${testId}-${value.toLowerCase()}`,
              },
            ]
          : [];
      }) ?? []
    );
  };
  const scope = nativeChoice(
    Object.values(DatabaseTaskScope),
    configured.value(AssistantInputTarget.TaskScope),
  );
  const lifecycle = nativeChoice(
    Object.values(DatabaseTaskLifecycle),
    configured.value(AssistantInputTarget.TaskLifecycle),
  );
  const dueValue = params.get("due");
  const due = Object.values(DatabaseTaskDuePreset).find(
    (value) => value === dueValue,
  );
  const statusValue = params.get("status");
  const sort =
    Object.values(DatabaseTaskSort).find(
      (value) => value === params.get("sort"),
    ) ?? DatabaseTaskSort.Due;
  const priorityFirst =
    sort === DatabaseTaskSort.Priority ||
    sort === DatabaseTaskSort.PriorityProject;
  const projectFirst =
    sort === DatabaseTaskSort.Project ||
    sort === DatabaseTaskSort.PriorityProject;
  const statusGroup = Object.values(DatabaseStatusGroup).find(
    (value) => value === statusValue,
  );
  const projectIds = useMemo(() => params.getAll("projectId"), [params]);
  const actorTimeZone = useRegionalPreferences().timezone;
  const input = useMemo(
    () => ({
      scope: activeFilters.has(AssistantTaskFilter.Scope) ? scope : undefined,
      lifecycle: activeFilters.has(AssistantTaskFilter.Lifecycle)
        ? lifecycle
        : undefined,
      projectIds: activeFilters.has(AssistantTaskFilter.Destination)
        ? projectIds
        : [],
      assigneeId: activeFilters.has(AssistantTaskFilter.Assignee)
        ? params.get("assigneeId") || undefined
        : undefined,
      statusGroup: activeFilters.has(AssistantTaskFilter.StatusGroup)
        ? statusGroup
        : undefined,
      due: activeFilters.has(AssistantTaskFilter.DuePreset) ? due : undefined,
      search: activeFilters.has(AssistantTaskFilter.Search)
        ? params.get("search") || undefined
        : undefined,
      blockedOnly:
        activeFilters.has(AssistantTaskFilter.BlockedOnly) &&
        params.get("blockedOnly") === "true",
      timeZone: actorTimeZone,
      sort,
    }),
    [
      scope,
      lifecycle,
      projectIds,
      params,
      statusGroup,
      due,
      actorTimeZone,
      activeFilters,
      sort,
    ],
  );
  const listRead = useWorkspaceTasks(
    input,
    20,
    params.get("after") || undefined,
    () => {
      if (!params.has("after")) return;
      const next = new URLSearchParams(view.location$.value.search);
      next.delete("after");
      setParams(next);
    },
    !kanban,
  );
  const boardRead = useWorkspaceTaskBoard(input, kanban);
  const {
    page,
    error,
    isLoading,
    mutate,
    availability,
    identity,
    workspaceId,
    live,
    retryLive,
    refresh,
  } = kanban ? boardRead : listRead;
  const statusAction = useTaskStatusAction(async () => {
    await refresh();
  });
  const destinationsRead = useTaskDestinations();
  const projects = destinationsRead.readyDestinations;
  const assistanceDestination = taskAssistanceDestination(
    input.projectIds,
    destinationsRead.defaultDestination?.databaseId,
    destinationsRead.readyDestinations,
  );
  const projectsLoading = destinationsRead.isLoading;
  const projectsError = destinationsRead.destinationError;
  const retryProjects = destinationsRead.mutate;
  const [creationOpen, setCreationOpen] = useState(false);
  const [openedAssistance, setOpenedAssistance] = useState<string | null>(null);
  const assistanceScope = JSON.stringify([
    identity,
    assistanceDestination?.databaseId,
  ]);
  const [assistanceSection, setAssistanceSection] = useState<string | null>(
    "assistance",
  );
  useEffect(() => {
    // A restored tool layout cannot open assistance, including after account ABA.
    setOpenedAssistance(null);
    const actorId = assistanceOwner.account?.id;
    const subscription = assistanceOwner.server?.account$.subscribe(
      (account) => {
        if (account?.id !== actorId) setOpenedAssistance(null);
      },
    );
    return () => subscription?.unsubscribe();
  }, [assistanceOwner.server, assistanceOwner.account?.id, assistanceScope]);
  useEffect(() => {
    // Intent mounts the native surface first; showTool cannot open an
    // unregistered surface during the originating menu event.
    if (
      openedAssistance === assistanceScope &&
      availability.status === "available" &&
      assistanceDestination
    ) {
      view.showTool("database-settings");
    }
  }, [
    openedAssistance,
    assistanceScope,
    availability.status,
    assistanceDestination?.databaseId,
    view,
  ]);
  const [creationOrigin, setCreationOrigin] =
    useState<TaskCreationOrigin>("tasks");
  const [creationReturn, setCreationReturn] = useState({
    path: "/home",
    scroll: null as string | null,
  });
  const [lastCreatedRowId, setLastCreatedRowId] = useState<string | null>(null);
  const creationTrigger = useRef<HTMLButtonElement>(null);
  const assistanceTrigger = useRef<HTMLButtonElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const dueFocusRequest = useRef(0);
  const [dueFocus, setDueFocus] = useState<{
    databaseId: string;
    rowId: string;
    request: number;
  } | null>(null);
  const searchControl = useRef<HTMLInputElement>(null);
  const selectedRowId = params.get("rowId");
  const selectedDatabaseId = params.get("databaseId");
  const detailWasVisible = useRef(false);
  const { navigation: taskNavigation, reset: resetTaskNavigation } =
    useTaskDetailNavigation(
      identity && selectedDatabaseId
        ? `${identity}:${selectedDatabaseId}`
        : null,
      selectedRowId,
      (rowId) => {
        // A detail click can precede the Router render after a filter change.
        // Preserve the owning View's already-committed query at invocation.
        const next = new URLSearchParams(view.location$.value.search);
        next.set("rowId", rowId);
        setParams(next);
      },
    );
  const requestTaskLeave = taskNavigation.requestLeave;
  const openTask = (
    databaseId: string,
    rowId: string,
    trigger?: HTMLElement | null,
    focusDue = false,
    search?: URLSearchParams,
  ) => {
    requestTaskLeave?.(() => {
      resetTaskNavigation();
      setDueFocus(
        focusDue
          ? { databaseId, rowId, request: ++dueFocusRequest.current }
          : null,
      );
      detailTrigger.current =
        trigger ?? (document.activeElement as HTMLElement | null);
      const next = new URLSearchParams(search ?? view.history.location.search);
      next.set("rowId", rowId);
      next.set("databaseId", databaseId);
      setParams(next);
    });
  };
  const closeTask = useCallback(() => {
    requestTaskLeave?.(() => {
      setDueFocus(null);
      const next = new URLSearchParams(view.history.location.search);
      const home = taskHomeReturnIntent(next);
      if (home) {
        view.hideTool("task-details");
        view.replace(
          taskCreationReturnRoute(
            home.returnTo,
            home.returnScroll,
            home.returnRowId,
          ),
        );
        return;
      }
      next.delete("rowId");
      next.delete("databaseId");
      setParams(next);
      view.hideTool("task-details");
      if (
        kanban &&
        page?.rows.some(
          (row) =>
            row.databaseId === selectedDatabaseId &&
            row.rowId === selectedRowId,
        )
      ) {
        setBoardFocus((previous) => ({
          requestId: (previous?.requestId ?? 0) + 1,
          selection: {
            cardId: taskCardId(selectedDatabaseId!, selectedRowId!),
          },
        }));
        return;
      }
      requestAnimationFrame(() => {
        const trigger = detailTrigger.current;
        (trigger?.isConnected
          ? trigger
          : (creationTrigger.current ?? searchControl.current)
        )?.focus();
      });
    });
  }, [
    setParams,
    view,
    requestTaskLeave,
    kanban,
    page,
    selectedDatabaseId,
    selectedRowId,
  ]);
  useEffect(() => {
    if (isActiveView && selectedRowId && selectedDatabaseId) {
      view.hideTool("database-settings");
      view.showTool("task-details");
    }
  }, [isActiveView, selectedRowId, selectedDatabaseId, view]);
  useEffect(() => {
    // The panel is shared; another pane closing it must not clear this Task URL.
    if (!isActiveView) {
      detailWasVisible.current = false;
      return;
    }
    // Closing the global host only collapses this retained editor. Removing
    // the Task tool itself is the explicit close that clears its URL identity.
    const visible = toolLayout.visibleToolIds.includes("task-details");
    // A deliberate assistance switch temporarily hides this body, retaining
    // its URL/native selection for the return journey.
    if (
      detailWasVisible.current &&
      !visible &&
      selectedRowId &&
      openedAssistance !== assistanceScope
    )
      closeTask();
    detailWasVisible.current = visible;
  }, [
    isActiveView,
    toolLayout.visibleToolIds,
    selectedRowId,
    closeTask,
    openedAssistance,
    assistanceScope,
  ]);
  useEffect(() => {
    setCreationOpen(false);
    setLastCreatedRowId(null);
    setDueFocus(null);
  }, [identity]);
  useEffect(() => {
    if (
      !canCreate ||
      availability.status !== "available" ||
      params.get("create") !== "task"
    )
      return;
    const intent = consumeTaskCreationIntent(params);
    if (!intent) return;
    setCreationOrigin(intent.origin);
    setCreationReturn({ path: intent.returnTo, scroll: intent.returnScroll });
    const query = intent.remaining.toString();
    workbench.open(`/tasks${query ? `?${query}` : ""}`, {
      at: "active",
      replaceHistory: true,
    });
    setCreationOpen(true);
  }, [params, canCreate, availability.status, workbench]);

  const update = (key: string, value?: string | null) => {
    // Consecutive controls can act before the router renders the previous edit.
    const next = new URLSearchParams(view.location$.value.search);
    next.delete("after");
    next.delete(key);
    if (value) next.set(key, value);
    setParams(next);
  };
  const filterLabel = (key: string, value: string) => {
    if (key === "projectId") {
      const project = projects.find((project) => project.id === value);
      return project?.workspaceTasks
        ? t["com.myoxus.common.without-project"]()
        : (project?.title ?? t["com.myoxus.database.tasks.destination"]());
    }
    if (key === "assigneeId")
      return (
        (assignee && !assignee.removed ? assignee.name : undefined) ??
        page?.rows
          .flatMap((row) => row.assignees)
          .find((user) => user.id === value)?.name ??
        t["com.myoxus.database.property.assignees"]()
      );
    if (key === "blockedOnly")
      return t["com.myoxus.database.progress.blocked"]();
    const labels: Record<string, string> = {
      [DatabaseStatusGroup.NotStarted]:
        t["com.myoxus.database.progress.group.not-started"](),
      [DatabaseStatusGroup.Active]:
        t["com.myoxus.database.progress.group.active"](),
      [DatabaseStatusGroup.Complete]:
        t["com.myoxus.database.progress.group.complete"](),
      [DatabaseStatusGroup.Archived]:
        t["com.myoxus.database.progress.group.archived"](),
      [DatabaseTaskDuePreset.Overdue]:
        t["com.myoxus.database.progress.overdue"](),
      [DatabaseTaskDuePreset.Today]: t["com.myoxus.common.calendar.today"](),
      [DatabaseTaskDuePreset.NextSevenDays]:
        t["com.myoxus.database.tasks.next-seven-days"](),
      [DatabaseTaskDuePreset.Unscheduled]:
        t["com.myoxus.database.tasks.unscheduled"](),
    };
    return (
      labels[value] ??
      (key === "due" ? t["com.myoxus.database.property.due"]() : t.Status())
    );
  };
  const status =
    availability.status === "unavailable"
      ? "local-unavailable"
      : error &&
          !(
            kanban &&
            page &&
            !["forbidden", "missing"].includes(classifyDatabaseError(error))
          )
        ? classifyDatabaseError(error)
        : isLoading || !page
          ? "loading"
          : "ready";
  const emptyLabel =
    status === "local-unavailable"
      ? t["com.myoxus.database.server-backed-only.title"]()
      : status === "forbidden"
        ? t["com.myoxus.database.embed.forbidden"]()
        : status === "offline"
          ? t["com.myoxus.database.embed.offline"]()
          : t["com.myoxus.database.embed.unavailable"]();
  const openProject = (databaseId: string, rowId?: string) =>
    workbench.open(
      `/databases/${databaseId}${rowId ? `?${new URLSearchParams({ rowId })}` : ""}`,
      { at: "active" },
    );
  const filterNames = {
    [AssistantTaskFilter.Scope]: t["com.myoxus.database.tasks.scope"](),
    [AssistantTaskFilter.Lifecycle]: t["com.myoxus.database.tasks.lifecycle"](),
    [AssistantTaskFilter.Search]: t["com.myoxus.database.tasks.search"](),
    [AssistantTaskFilter.Destination]:
      t["com.myoxus.database.template.profile.project"](),
    [AssistantTaskFilter.Assignee]:
      t["com.myoxus.database.property.assignees"](),
    [AssistantTaskFilter.StatusGroup]: t.Status(),
    [AssistantTaskFilter.DuePreset]: t["com.myoxus.database.property.due"](),
    [AssistantTaskFilter.BlockedOnly]:
      t["com.myoxus.database.progress.blocked"](),
  };
  const scopeChoices = sourceChoices(
    AssistantInputTarget.TaskScope,
    Object.values(DatabaseTaskScope),
    "tasks-scope",
  );
  const lifecycleChoices = sourceChoices(
    AssistantInputTarget.TaskLifecycle,
    Object.values(DatabaseTaskLifecycle),
    "tasks-lifecycle",
  );
  const choiceItems = (
    choices: { value: string; label: string }[],
    selected: string | undefined,
    select: (value: string) => void,
  ) =>
    choices.map((choice) => (
      <MenuItem
        key={choice.value}
        checked={selected === choice.value}
        onSelect={() => select(choice.value)}
      >
        {choice.label}
      </MenuItem>
    ));
  const filterOptions = (filter: AssistantTaskFilter) => {
    switch (filter) {
      case AssistantTaskFilter.Scope:
        return choiceItems(scopeChoices, scope, (value) =>
          update("scope", value),
        );
      case AssistantTaskFilter.Lifecycle:
        return choiceItems(lifecycleChoices, lifecycle, (value) =>
          update("lifecycle", value),
        );
      case AssistantTaskFilter.Destination:
        return (
          <>
            <MenuItem
              checked={!projectIds.length}
              onSelect={() => update("projectId")}
            >
              {t["com.myoxus.database.filter.all"]()}
            </MenuItem>
            {projects.map((project) => (
              <MenuItem
                key={project.id}
                checked={projectIds.includes(project.id)}
                onSelect={() => update("projectId", project.id)}
              >
                {project.workspaceTasks
                  ? t["com.myoxus.common.without-project"]()
                  : project.title}
              </MenuItem>
            ))}
            {destinationsRead.isLoading || destinationsRead.isLoadingMore ? (
              <MenuItem disabled closeMenuOnClick={false}>
                {t["Loading"]()}
              </MenuItem>
            ) : null}
            {destinationsRead.error ? (
              <>
                <MenuItem disabled closeMenuOnClick={false}>
                  {t["com.myoxus.database.embed.unavailable"]()}
                </MenuItem>
                <MenuItem
                  closeMenuOnClick={false}
                  disabled={
                    destinationsRead.isLoading || destinationsRead.isLoadingMore
                  }
                  onSelect={() => void destinationsRead.mutate()}
                >
                  {t.Retry()}
                </MenuItem>
              </>
            ) : null}
            {destinationsRead.nextCursor ? (
              <MenuItem
                closeMenuOnClick={false}
                disabled={
                  destinationsRead.isLoading ||
                  destinationsRead.isLoadingMore ||
                  Boolean(destinationsRead.error)
                }
                onSelect={() => void destinationsRead.loadMore()}
              >
                {t["com.myoxus.database.load-more"]()}
              </MenuItem>
            ) : null}
          </>
        );
      case AssistantTaskFilter.Assignee:
        return (
          <>
            <MenuItem
              checked={!params.get("assigneeId")}
              onSelect={() => update("assigneeId")}
            >
              {t["com.myoxus.database.filter.all"]()}
            </MenuItem>
            <MenuSeparator />
            <MemberSelector
              selected={
                params.get("assigneeId") ? [params.get("assigneeId")!] : []
              }
              selectionMode="single"
              onChange={(value) => update("assigneeId", value.at(-1))}
            />
          </>
        );
      case AssistantTaskFilter.StatusGroup:
        return (
          <>
            <MenuItem checked={!statusGroup} onSelect={() => update("status")}>
              {t["com.myoxus.database.filter.all"]()}
            </MenuItem>
            {choiceItems(
              [
                {
                  value: DatabaseStatusGroup.NotStarted,
                  label: t["com.myoxus.database.progress.group.not-started"](),
                },
                {
                  value: DatabaseStatusGroup.Active,
                  label: t["com.myoxus.database.progress.group.active"](),
                },
                {
                  value: DatabaseStatusGroup.Complete,
                  label: t["com.myoxus.database.progress.group.complete"](),
                },
                {
                  value: DatabaseStatusGroup.Archived,
                  label: t["com.myoxus.database.progress.group.archived"](),
                },
              ],
              statusGroup,
              (value) => update("status", value),
            )}
          </>
        );
      case AssistantTaskFilter.BlockedOnly:
        return choiceItems(
          [
            { value: "all", label: t["com.myoxus.database.filter.all"]() },
            {
              value: "blocked",
              label: t["com.myoxus.database.progress.blocked"](),
            },
          ],
          input.blockedOnly ? "blocked" : "all",
          (value) =>
            update("blockedOnly", value === "blocked" ? "true" : undefined),
        );
      case AssistantTaskFilter.DuePreset:
        return (
          <>
            <MenuItem checked={!due} onSelect={() => update("due")}>
              {t["com.myoxus.database.filter.all"]()}
            </MenuItem>
            {choiceItems(
              [
                {
                  value: DatabaseTaskDuePreset.Overdue,
                  label: t["com.myoxus.database.progress.overdue"](),
                },
                {
                  value: DatabaseTaskDuePreset.Today,
                  label: t["com.myoxus.common.calendar.today"](),
                },
                {
                  value: DatabaseTaskDuePreset.NextSevenDays,
                  label: t["com.myoxus.database.tasks.next-seven-days"](),
                },
                {
                  value: DatabaseTaskDuePreset.Unscheduled,
                  label: t["com.myoxus.database.tasks.unscheduled"](),
                },
              ],
              due,
              (value) => update("due", value),
            )}
          </>
        );
      default:
        return null;
    }
  };
  const additionalFilters = {
    projectId: AssistantTaskFilter.Destination,
    assigneeId: AssistantTaskFilter.Assignee,
    status: AssistantTaskFilter.StatusGroup,
    due: AssistantTaskFilter.DuePreset,
    blockedOnly: AssistantTaskFilter.BlockedOnly,
  };
  const renderFilterChip = (
    filter: AssistantTaskFilter,
    label: string,
    remove?: () => void,
    key: string = filter,
  ) => (
    <FilterChip key={key} active>
      <Menu title={filterNames[filter]} items={filterOptions(filter)}>
        <FilterChipTrigger tone="primary">{label}</FilterChipTrigger>
      </Menu>
      {remove ? (
        <IconButton
          aria-label={t["Remove special filter"]()}
          icon={<CloseIcon />}
          onClick={remove}
        />
      ) : null}
    </FilterChip>
  );
  const resetFilters = () => {
    const next = new URLSearchParams(view.location$.value.search);
    // Removing explicit choices restores the server-authored inventory defaults.
    for (const key of [
      "scope",
      "lifecycle",
      "search",
      "after",
      ...Object.keys(additionalFilters),
    ])
      next.delete(key);
    setParams(next);
  };
  const toggleDisplay = (value: "assignees" | "priority", checked: boolean) => {
    const next = new URLSearchParams(view.location$.value.search);
    const values = next.getAll("display").filter((item) => item !== value);
    next.delete("display");
    for (const item of checked ? [...values, value] : values)
      next.append("display", item);
    setParams(next);
  };
  const toggleSort = (choice: "priority" | "project") => {
    const current = new URLSearchParams(view.location$.value.search).get(
      "sort",
    );
    let priority =
      current === DatabaseTaskSort.Priority ||
      current === DatabaseTaskSort.PriorityProject;
    let project =
      current === DatabaseTaskSort.Project ||
      current === DatabaseTaskSort.PriorityProject;
    if (choice === "priority") priority = !priority;
    else project = !project;
    update(
      "sort",
      priority
        ? project
          ? DatabaseTaskSort.PriorityProject
          : DatabaseTaskSort.Priority
        : project
          ? DatabaseTaskSort.Project
          : undefined,
    );
  };
  const renderInventory = (columns: readonly AssistantTaskSummaryValue[]) =>
    presentation.isLoading ? (
      <Loading />
    ) : !descriptor ? (
      <Notice tone="warning">
        <Button onClick={() => void presentation.mutate()}>{t.Retry()}</Button>
      </Notice>
    ) : status === "loading" ? (
      <Loading />
    ) : status !== "ready" ? (
      <EmptyState
        title={emptyLabel}
        cta={
          status === "offline" || status === "unavailable" ? (
            <Button onClick={() => void mutate()}>{t.Retry()}</Button>
          ) : undefined
        }
      />
    ) : !page ? (
      <Loading />
    ) : (
      <>
        <MyoxusText tone="secondary">
          {kanban && page.rows.length < page.totalCount
            ? t["com.myoxus.database.tasks.loaded"]({
                loaded: page.rows.length.toLocaleString(t.language),
                total: page.totalCount.toLocaleString(t.language),
              })
            : page.totalCount === 1
              ? t["com.myoxus.database.tasks.count_one"]({
                  count: page.totalCount,
                })
              : t["com.myoxus.database.tasks.count_other"]({
                  count: page.totalCount,
                })}
        </MyoxusText>
        {kanban ? (
          <>
            {!page.rows.length ? (
              <EmptyState title={t["com.myoxus.database.tasks.no-matches"]()} />
            ) : null}
            <TaskKanban
              key={boardRead.queryIdentity}
              page={page}
              timeZone={actorTimeZone}
              defaultDatabaseId={
                destinationsRead.defaultDestination?.databaseId
              }
              display={display}
              statusAction={statusAction}
              selected={
                selectedDatabaseId && selectedRowId
                  ? taskCardId(selectedDatabaseId, selectedRowId)
                  : undefined
              }
              focusRequest={boardFocus}
              onSelectionTargetChange={(target) => {
                detailTrigger.current = target;
              }}
              onOpenTask={(row, trigger) =>
                openTask(row.databaseId, row.rowId, trigger)
              }
            />
            {boardRead.error ? (
              <Notice
                tone="warning"
                title={t["com.myoxus.database.embed.unavailable"]()}
              >
                <Button
                  disabled={boardRead.isValidating}
                  onClick={() => void boardRead.retry()}
                >
                  {t.Retry()}
                </Button>
              </Notice>
            ) : page.nextCursor ? (
              <Group>
                <Button
                  disabled={boardRead.isLoadingMore}
                  onClick={() => void boardRead.loadMore()}
                >
                  {boardRead.isLoadingMore
                    ? t.Loading()
                    : t["com.myoxus.database.load-more"]()}
                </Button>
              </Group>
            ) : null}
          </>
        ) : !page.rows.length ? (
          <EmptyState title={t["com.myoxus.database.tasks.no-matches"]()} />
        ) : (
          <>
            <TableScrollContainer containInlineSize>
              <Table highlightOnHover data-testid="tasks-table">
                <TableBody>
                  {page.rows.map((row) => {
                    const due = presentTaskDue(
                      row.due,
                      t.language,
                      actorTimeZone,
                    );
                    const selected =
                      row.rowId === selectedRowId &&
                      row.databaseId === selectedDatabaseId;
                    const complete =
                      row.status?.group === DatabaseStatusGroup.Complete;
                    return (
                      <TableRow
                        key={row.rowId}
                        data-testid={`task-row-${row.rowId}`}
                        aria-selected={selected}
                      >
                        <TableCell selected={selected}>
                          <Group wrap="nowrap" align="flex-start">
                            <Checkbox
                              checked={complete}
                              aria-label={`${complete ? t["com.myoxus.database.tasks.reopen"]() : t.Complete()}: ${row.title}`}
                              disabled={
                                !row.canEdit ||
                                Boolean(row.deletedAt) ||
                                !statusAction.canEdit ||
                                Boolean(
                                  statusAction.pending ||
                                  statusAction.uncertain,
                                )
                              }
                              onChange={() =>
                                void statusAction.change(row, !complete)
                              }
                            />
                            <Box>
                              <WorkbenchLink
                                ref={(node) => {
                                  if (
                                    node &&
                                    row.rowId === selectedRowId &&
                                    !detailTrigger.current?.isConnected
                                  )
                                    detailTrigger.current = node;
                                }}
                                replaceHistory
                                to={`/tasks?${new URLSearchParams(
                                  [...params.entries()]
                                    .filter(
                                      ([key]) =>
                                        key !== "rowId" && key !== "databaseId",
                                    )
                                    .concat([
                                      ["rowId", row.rowId],
                                      ["databaseId", row.databaseId],
                                    ]),
                                )}${workbench.location$.value.hash}`}
                                onClick={(event) => {
                                  if (
                                    event.defaultPrevented ||
                                    inferOpenMode(event) !== "active"
                                  )
                                    return;
                                  // Reset return frames only after the current editor
                                  // accepts leaving; Stay must retain its draft slot.
                                  event.preventDefault();
                                  openTask(
                                    row.databaseId,
                                    row.rowId,
                                    event.currentTarget as HTMLElement,
                                  );
                                }}
                              >
                                <MyoxusText
                                  component="span"
                                  lineClamp={2}
                                  title={row.title}
                                >
                                  {row.title}
                                </MyoxusText>
                              </WorkbenchLink>
                              {row.descriptionPreview ? (
                                <MyoxusText
                                  tone="secondary"
                                  typographySlot="body-small"
                                  lineClamp={2}
                                >
                                  {row.descriptionPreview}
                                </MyoxusText>
                              ) : null}
                              <Group>
                                <MyoxusText
                                  tone="secondary"
                                  typographySlot="body-small"
                                >
                                  {row.status?.id
                                    ? taskOptionDisplayName(
                                        t,
                                        "task.status",
                                        row.status.id,
                                      )
                                    : t[
                                        "com.myoxus.database.tasks.status-unavailable"
                                      ]()}
                                </MyoxusText>
                                {columns.includes(
                                  AssistantTaskSummaryValue.Destination,
                                ) &&
                                destinationsRead.defaultDestination &&
                                row.databaseId !==
                                  destinationsRead.defaultDestination
                                    .databaseId ? (
                                  <Badge>{row.projectTitle}</Badge>
                                ) : null}
                                <TaskBlockerIndicator counts={row.blockers} />
                                {display.assignees && row.assignees.length ? (
                                  <MyoxusText
                                    tone="secondary"
                                    typographySlot="body-small"
                                  >
                                    {row.assignees
                                      .map((a) => a.name)
                                      .join(", ")}
                                  </MyoxusText>
                                ) : null}
                                {display.priority && row.priority ? (
                                  <MyoxusText
                                    tone="secondary"
                                    typographySlot="body-small"
                                  >
                                    {taskOptionDisplayName(
                                      t,
                                      "task.priority",
                                      row.priority.id,
                                    )}
                                  </MyoxusText>
                                ) : null}
                              </Group>
                            </Box>
                          </Group>
                        </TableCell>
                        {columns.includes(AssistantTaskSummaryValue.Due) ? (
                          <TableCell selected={selected}>
                            {due ? (
                              <Button
                                variant="plain"
                                onClick={(event) => {
                                  openTask(
                                    row.databaseId,
                                    row.rowId,
                                    event.currentTarget,
                                    true,
                                  );
                                }}
                                aria-label={t[
                                  "com.myoxus.database.property.due"
                                ]()}
                              >
                                {due.label}
                              </Button>
                            ) : null}
                          </TableCell>
                        ) : null}
                        {columns.includes(
                          AssistantTaskSummaryValue.RowActions,
                        ) ? (
                          <TableCell selected={selected}>
                            <ContextDocumentTaskMenu
                              target={{
                                databaseId: row.databaseId,
                                taskId: row.rowId,
                                title: row.title,
                                projectId:
                                  row.databaseId ===
                                  destinationsRead.defaultDestination
                                    ?.databaseId
                                    ? undefined
                                    : row.databaseId,
                              }}
                              onOpenProject={() =>
                                openProject(row.databaseId, row.rowId)
                              }
                            />
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScrollContainer>
            <Group>
              {params.has("after") ? (
                <Button variant="secondary" onClick={() => update("after")}>
                  {t["common.first-page"]()}
                </Button>
              ) : null}
              {page.nextCursor ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.set("after", page.nextCursor!);
                    setParams(next);
                  }}
                >
                  {t["common.next"]()}
                </Button>
              ) : null}
            </Group>
          </>
        )}
      </>
    );
  return (
    <ContextDocumentAssistance
      databaseId={assistanceDestination?.databaseId}
      title={assistanceDestination?.title ?? ""}
      projectId={
        assistanceDestination && !assistanceDestination.workspaceTasks
          ? assistanceDestination.databaseId
          : undefined
      }
      enabled={
        availability.status === "available" && Boolean(assistanceDestination)
      }
      requestOpen={(open) => {
        if (taskNavigation.requestLeave) taskNavigation.requestLeave(open);
        else open();
      }}
      onShow={() => {
        setOpenedAssistance(assistanceScope);
        setAssistanceSection("assistance");
        view.hideTool("task-details");
        view.showTool("database-settings");
      }}
      onClose={() => {
        setOpenedAssistance(null);
        view.hideTool("database-settings");
        if (selectedRowId && selectedDatabaseId) view.showTool("task-details");
        requestAnimationFrame(() => {
          const trigger = detailTrigger.current;
          (trigger?.isConnected ? trigger : assistanceTrigger.current)?.focus();
        });
      }}
    >
      {({ menu, content, available }) => (
        <>
          {openedAssistance === assistanceScope &&
          availability.status === "available" &&
          assistanceDestination ? (
            <DatabaseWorkbenchContextSurface
              label={t["com.myoxus.assistance.title"]()}
            >
              <WorkbenchContextScrollRoot>
                <Scrollable.Viewport scrollbars="y">
                  <Accordion
                    value={assistanceSection}
                    onChange={(value) => {
                      if (!Array.isArray(value)) setAssistanceSection(value);
                    }}
                  >
                    {content ? (
                      <AccordionItem value="assistance">
                        <AccordionControl>
                          {t["com.myoxus.assistance.title"]()}
                        </AccordionControl>
                        <AccordionPanel>{content}</AccordionPanel>
                      </AccordionItem>
                    ) : null}
                    {availability.status === "available" &&
                    assistanceDestination ? (
                      <AccordionItem value="automations">
                        <AccordionControl>
                          {t["com.myoxus.database.automation.title"]()}
                        </AccordionControl>
                        <AccordionPanel>
                          <DatabaseAutomationsPanel
                            key={JSON.stringify([
                              identity,
                              assistanceDestination.databaseId,
                            ])}
                            workspaceId={workspaceId}
                            databaseId={assistanceDestination.databaseId}
                            canUseTaskAssistance={available}
                            canEdit={false}
                          />
                        </AccordionPanel>
                      </AccordionItem>
                    ) : null}
                  </Accordion>
                </Scrollable.Viewport>
              </WorkbenchContextScrollRoot>
            </DatabaseWorkbenchContextSurface>
          ) : null}
          <WorkbenchToolLayoutBinding
            workspaceId={workspaceId}
            viewFamily="database"
          />
          {selectedRowId && selectedDatabaseId && identity ? (
            <ViewContextSurface
              surfaceId="task-details"
              label={t["com.myoxus.database.row_detail.task-title"]()}
              icon={<ListChecksIcon />}
              viewFamilies={TASK_VIEW_FAMILIES}
              beforeClose={taskNavigation.requestLeave}
              retainBodyWhenCollapsed
            >
              <TaskDetailNavigationContext.Provider value={taskNavigation}>
                <TaskDetail
                  key={`${identity}:${selectedDatabaseId}:${selectedRowId}`}
                  databaseId={selectedDatabaseId}
                  rowId={selectedRowId}
                  focusDue={
                    dueFocus?.databaseId === selectedDatabaseId &&
                    dueFocus.rowId === selectedRowId
                      ? dueFocus.request
                      : undefined
                  }
                  onDueFocused={(request) =>
                    setDueFocus((current) =>
                      current?.request === request ? null : current,
                    )
                  }
                  onChanged={async () => {
                    await refresh();
                  }}
                  onOpenDoc={(docId) =>
                    workbench.open(`/${docId}`, { at: "active" })
                  }
                  onOpenProject={(databaseId) =>
                    openProject(databaseId, selectedRowId)
                  }
                  onOpenTask={(databaseId, rowId) =>
                    openTask(databaseId, rowId)
                  }
                />
              </TaskDetailNavigationContext.Provider>
            </ViewContextSurface>
          ) : null}
          <ViewTitle title={t["com.myoxus.database.progress.tasks"]()} />
          <ViewIcon icon="collection" />
          <ViewHeader>
            <WorkbenchHeaderFrame
              left={
                <ViewSwitcher
                  aria-label={t.switchView()}
                  value={kanban ? "kanban" : "list"}
                  items={[
                    {
                      value: "list",
                      label: t["com.myoxus.database.view.list"](),
                      icon: <AllDocsListViewIcon />,
                    },
                    {
                      value: "kanban",
                      label: t["com.myoxus.database.view.kanban"](),
                      icon: <DatabaseKanbanViewIcon />,
                    },
                  ]}
                  onChange={(value) => {
                    const next = new URLSearchParams(
                      view.location$.value.search,
                    );
                    next.delete("after");
                    if (value === "kanban") next.set("view", value);
                    else next.delete("view");
                    setParams(next);
                  }}
                />
              }
              title={
                <WorkbenchHeaderContextPath
                  current={t["com.myoxus.database.progress.tasks"]()}
                />
              }
              right={
                availability.status === "available" &&
                assistanceOwner.server &&
                assistanceOwner.account ? (
                  <HeaderMenuButton
                    ref={assistanceTrigger}
                    ariaLabel={t["com.myoxus.common.open-menu"]()}
                    data-testid="tasks-assistance-menu"
                    items={
                      <MenuPanel>
                        <MenuItem
                          checked={priorityFirst}
                          closeMenuOnClick={false}
                          onSelect={() => toggleSort("priority")}
                        >
                          {t["com.myoxus.database.tasks.sort-priority"]()}
                        </MenuItem>
                        <MenuItem
                          checked={projectFirst}
                          closeMenuOnClick={false}
                          onSelect={() => toggleSort("project")}
                        >
                          {t["com.myoxus.database.tasks.sort-project"]()}
                        </MenuItem>
                        {(!priorityFirst && !projectFirst) ||
                        (priorityFirst && projectFirst) ? (
                          <MenuSectionLabel>
                            {priorityFirst
                              ? t[
                                  "com.myoxus.database.tasks.sort-priority-project"
                                ]()
                              : t["com.myoxus.database.property.due"]()}
                          </MenuSectionLabel>
                        ) : null}
                        <MenuSeparator />
                        <MenuSectionLabel>
                          {t["com.myoxus.explorer.display-menu.button"]()}
                        </MenuSectionLabel>
                        {(["assignees", "priority"] as const).map((value) => (
                          <MenuItem
                            key={value}
                            checked={display[value]}
                            closeMenuOnClick={false}
                            onSelect={() =>
                              toggleDisplay(value, !display[value])
                            }
                          >
                            {value === "assignees"
                              ? t["com.myoxus.database.property.assignees"]()
                              : t["com.myoxus.database.property.priority"]()}
                          </MenuItem>
                        ))}
                        <MenuSeparator />
                        <MenuSectionLabel>
                          {t["com.myoxus.assistance.title"]()}
                        </MenuSectionLabel>
                        <AssistancePreference
                          service={assistanceOwner.server.scope.get(
                            UserPreferencesService,
                          )}
                          workspaceId={workspaceId}
                          projectId={
                            assistanceDestination &&
                            !assistanceDestination.workspaceTasks
                              ? assistanceDestination.databaseId
                              : undefined
                          }
                          menu
                        />
                        {menu(
                          assistanceDestination
                            ? {
                                databaseId: assistanceDestination.databaseId,
                                title: assistanceDestination.title,
                                projectId: assistanceDestination.workspaceTasks
                                  ? undefined
                                  : assistanceDestination.databaseId,
                                returnFocusRef: assistanceTrigger,
                              }
                            : undefined,
                        )}
                        {assistanceDestination ? (
                          <MenuItem
                            onSelect={() => {
                              const open = () => {
                                setOpenedAssistance(assistanceScope);
                                setAssistanceSection("automations");
                                view.hideTool("task-details");
                                view.showTool("database-settings");
                              };
                              if (taskNavigation.requestLeave)
                                taskNavigation.requestLeave(open);
                              else open();
                            }}
                          >
                            {t["com.myoxus.database.automation.title"]()}
                          </MenuItem>
                        ) : null}
                        {status === "ready" &&
                        page &&
                        !page.coverageComplete ? (
                          <>
                            <MenuSeparator />
                            <TaskCoverageNotice
                              menu
                              coverageComplete={page.coverageComplete}
                              unavailableProjects={page.unavailableProjects}
                              onRetry={() => void mutate()}
                            />
                          </>
                        ) : null}
                      </MenuPanel>
                    }
                  />
                ) : undefined
              }
            />
          </ViewHeader>
          <ViewBody>
            <Scrollable.Viewport
              ref={inventoryScroll}
              onScroll={(event) => {
                scrollPositions.current[kanban ? "kanban" : "list"] =
                  event.currentTarget.scrollTop;
              }}
              scrollbars="y"
              fill
            >
              <PageContentRail
                spacious
                scroll
                width="wide"
                data-testid="workspace-tasks"
              >
                <Stack>
                  {!live && availability.status === "available" ? (
                    <Notice
                      tone="warning"
                      title={t["com.myoxus.database.realtime.unavailable"]()}
                    >
                      <Button
                        variant="plain"
                        onClick={() => {
                          retryLive();
                          void mutate();
                        }}
                      >
                        {t.Retry()}
                      </Button>
                    </Notice>
                  ) : null}
                  {statusAction.failed || statusAction.uncertain ? (
                    <Notice
                      tone="warning"
                      title={
                        statusAction.uncertain
                          ? statusAction.refreshFailed
                            ? t[
                                "com.myoxus.database.tasks.status-refresh-failed"
                              ]()
                            : t[
                                "com.myoxus.database.tasks.status-unconfirmed"
                              ]()
                          : t["com.myoxus.common.operation-failed"]()
                      }
                    >
                      {statusAction.uncertain ? (
                        <Button
                          disabled={Boolean(statusAction.pending)}
                          onClick={() => void statusAction.recover()}
                        >
                          {t["com.myoxus.database.conflict.reload"]()}
                        </Button>
                      ) : null}
                    </Notice>
                  ) : null}
                  {statusAction.undo ? (
                    <Notice tone="success">
                      <Button
                        disabled={Boolean(
                          statusAction.pending || statusAction.uncertain,
                        )}
                        onClick={() => void statusAction.undoLast()}
                      >
                        {t.Undo()}
                      </Button>
                    </Notice>
                  ) : null}
                  {!descriptor ? (
                    <Stack>
                      <FilterBar>
                        <TaskRecurrenceManager
                          onOpenTask={(databaseId, rowId) =>
                            openTask(databaseId, rowId)
                          }
                          onChanged={async () => {
                            await refresh();
                          }}
                        />
                      </FilterBar>
                      <Notice tone="warning">
                        <Button onClick={() => void presentation.mutate()}>
                          {t.Retry()}
                        </Button>
                      </Notice>
                    </Stack>
                  ) : (
                    configured.groups.map((group) => (
                      <Stack key={group.id}>
                        {group.title ? (
                          <MyoxusText>
                            {assistantText(group.title, t.language)}
                          </MyoxusText>
                        ) : null}
                        {group.role === AssistantGroupRole.Filters &&
                        availability.status === "available" ? (
                          <FilterBar data-testid="tasks-filter-bar">
                            <TaskRecurrenceManager
                              onOpenTask={(databaseId, rowId) =>
                                openTask(databaseId, rowId)
                              }
                              onChanged={async () => {
                                await refresh();
                              }}
                            />
                            {assistanceOwner.server &&
                            assistanceOwner.account &&
                            canCreate &&
                            allowsCreate ? (
                              <Button
                                ref={creationTrigger}
                                variant="primary"
                                onClick={() => {
                                  setCreationOrigin("tasks");
                                  setCreationOpen(true);
                                }}
                                data-testid="tasks-new-task"
                              >
                                {t["com.myoxus.database.tasks.new"]()}
                              </Button>
                            ) : null}
                            {activeFilters.has(AssistantTaskFilter.Search) ? (
                              <SearchInput
                                ref={searchControl}
                                aria-label={t[
                                  "com.myoxus.database.tasks.search"
                                ]()}
                                placeholder={t[
                                  "com.myoxus.database.tasks.search"
                                ]()}
                                value={params.get("search") || ""}
                                onChange={(value) => update("search", value)}
                              />
                            ) : null}
                            <Menu
                              title={t["com.myoxus.filter"]()}
                              items={
                                <MenuPanel>
                                  {filters
                                    .filter(
                                      (filter) =>
                                        filter !== AssistantTaskFilter.Search,
                                    )
                                    .map((filter) =>
                                      filter ===
                                      AssistantTaskFilter.BlockedOnly ? (
                                        <MenuItem
                                          key={filter}
                                          checked={input.blockedOnly}
                                          onSelect={() =>
                                            update(
                                              "blockedOnly",
                                              input.blockedOnly
                                                ? undefined
                                                : "true",
                                            )
                                          }
                                        >
                                          {filterNames[filter]}
                                        </MenuItem>
                                      ) : (
                                        <MenuSub
                                          key={filter}
                                          items={filterOptions(filter)}
                                        >
                                          {filterNames[filter]}
                                        </MenuSub>
                                      ),
                                    )}
                                  <MenuSeparator />
                                  <MenuItem onSelect={resetFilters}>
                                    {t[
                                      "com.myoxus.database.view.clear-filters"
                                    ]()}
                                  </MenuItem>
                                </MenuPanel>
                              }
                            >
                              <FilterChipTrigger prefix={<FilterIcon />}>
                                {t["com.myoxus.filter"]()}
                              </FilterChipTrigger>
                            </Menu>
                            {activeFilters.has(AssistantTaskFilter.Scope) &&
                            scope
                              ? renderFilterChip(
                                  AssistantTaskFilter.Scope,
                                  scopeChoices.find(
                                    (choice) => choice.value === scope,
                                  )?.label ?? scope,
                                )
                              : null}
                            {activeFilters.has(AssistantTaskFilter.Lifecycle) &&
                            lifecycle
                              ? renderFilterChip(
                                  AssistantTaskFilter.Lifecycle,
                                  lifecycleChoices.find(
                                    (choice) => choice.value === lifecycle,
                                  )?.label ?? lifecycle,
                                )
                              : null}
                            {Object.entries(additionalFilters).flatMap(
                              ([key, filter]) =>
                                activeFilters.has(filter)
                                  ? params
                                      .getAll(key)
                                      .filter(
                                        (value) =>
                                          key !== "blockedOnly" ||
                                          value === "true",
                                      )
                                      .map((value) =>
                                        renderFilterChip(
                                          filter,
                                          filterLabel(key, value),
                                          () => {
                                            const next = new URLSearchParams(
                                              view.location$.value.search,
                                            );
                                            next.delete(key, value);
                                            next.delete("after");
                                            setParams(next);
                                          },
                                          key + ":" + value,
                                        ),
                                      )
                                  : [],
                            )}
                          </FilterBar>
                        ) : null}
                        {group.role === AssistantGroupRole.Inventory
                          ? renderInventory(
                              group.controls.flatMap((control) =>
                                control.kind ===
                                  AssistantControlKind.TaskSummary &&
                                control.value
                                  ? [control.value]
                                  : [],
                              ),
                            )
                          : null}
                      </Stack>
                    ))
                  )}
                </Stack>
              </PageContentRail>
            </Scrollable.Viewport>
          </ViewBody>
          {canCreate && availability.status === "available" ? (
            <NewTaskModal
              key={`${identity}:${lastCreatedRowId ?? "draft"}`}
              open={creationOpen}
              scope={input.scope}
              projects={projects}
              destinationsUnavailable={
                !destinationsRead.defaultDestination ||
                destinationsRead.defaultDestination.managedSchema.readiness !==
                  "Ready"
              }
              onLoadMoreProjects={
                destinationsRead.nextCursor
                  ? () => void destinationsRead.loadMore()
                  : undefined
              }
              projectsLoading={projectsLoading}
              projectsError={Boolean(projectsError)}
              onRetryProjects={() => void retryProjects()}
              returnToHome={creationOrigin === "home"}
              initialProjectId={
                input.projectIds.length === 1 ? input.projectIds[0] : undefined
              }
              returnFocusRef={creationTrigger}
              onClose={() => {
                setCreationOpen(false);
                if (creationOrigin === "home")
                  workbench.open(
                    taskCreationReturnRoute(
                      creationReturn.path,
                      creationReturn.scroll,
                    ),
                    { at: "active", replaceHistory: true },
                  );
              }}
              onOpenProject={(databaseId) => {
                setCreationOpen(false);
                workbench.open(`/databases/${databaseId}`, { at: "new-tab" });
              }}
              onOpenTask={(task) => {
                setCreationOpen(false);
                workbench.open(
                  `/databases/${task.databaseId}?${new URLSearchParams({ rowId: task.rowId })}`,
                  { at: "new-tab" },
                );
              }}
              onCreated={(task) => {
                setLastCreatedRowId(task.rowId);
                setCreationOpen(false);
                const next = new URLSearchParams(view.location$.value.search);
                if (creationOrigin === "home") {
                  // Keep the confirmed result attached to the original Home entry.
                  next.set("origin", "home");
                  next.set("returnTo", creationReturn.path);
                  if (creationReturn.scroll !== null)
                    next.set("returnScroll", creationReturn.scroll);
                  next.delete("returnRowId");
                }
                // Open the confirmed identity directly, including results outside
                // the current filters. Success feedback uses the shared toast lifetime.
                void Promise.allSettled([mutate()]);
                openTask(
                  task.databaseId,
                  task.rowId,
                  creationTrigger.current,
                  false,
                  next,
                );
                notify.success({
                  title: t["com.myoxus.database.tasks.created"]({
                    title: task.title,
                  }),
                });
              }}
            />
          ) : null}
        </>
      )}
    </ContextDocumentAssistance>
  );
}
export function Component() {
  return (
    <DatabaseConflictProvider>
      <TasksPage />
    </DatabaseConflictProvider>
  );
}
