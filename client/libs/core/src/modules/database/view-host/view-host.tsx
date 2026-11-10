// SPDX-License-Identifier: AGPL-3.0-or-later

import { ActivePeopleTool } from "../../content-presence/active-people-tool";

import { ContextDocumentAssistance } from "../assistance/context-documents";
import { databaseManagedCapabilities } from "../managed";
import { managedTaskUnavailableLabel } from "../tasks/managed-feedback";

import {
  databaseRowQuery,
  DatabaseFieldKind,
  DatabaseFilterConjunction,
  type DatabaseFilterRuleInput,
  DatabaseViewKind,
  DatabaseTimelineZoom,
  DatabaseTimelineGroupBy,
} from "@myoxus/graphql";
import { TaskDetailNavigationContext } from "../row-detail/task-navigation";
import { useI18n } from "@myoxus/i18n";
import {
  CloseIcon,
  FilterIcon,
  GroupingIcon,
  PlusIcon,
  PropertyIcon,
  SearchIcon,
  SettingsIcon,
  SortIcon,
} from "@myoxus/icons/react";
import {
  Badge,
  Alert,
  Button,
  FilterBar,
  FilterChip,
  FilterChipSegment,
  FilterChipTrigger,
  Group,
  IconButton,
  Input,
  Loading,
  LocalizedDateInput,
  Select,
  notify,
  MyoxusText,
  Notice,
  Stack,
  Tabs,
  TabsContent,
} from "@myoxus/ui-facade";
import { useCallback, useRef } from "react";

import { DatabaseCalendarView } from "../calendar";
import { FieldSettingsModal } from "../field-settings";
import { DatabaseGalleryView } from "../gallery";
import { DatabaseGanttView } from "../gantt";
import { DatabaseKanbanView } from "../kanban";
import { DatabaseListView } from "../list";
import {
  databaseFilterValueInputFromOutput,
  getFieldById,
  sortByPosition,
  getViewGroupRules,
} from "../model";
import {
  DatabaseConflictProvider,
  DatabasePresenceProvider,
  useDatabasePresence,
  useDatabaseSocket,
} from "../presence";
import { DatabaseProgressView } from "../progress";
import {
  DatabaseRowActionMenu,
  DatabaseRowDetailContext,
  DatabaseRowDetailPeek,
  DatabaseRowStateBadges,
  DatabaseViewFieldValues,
} from "../row-detail";
import { RowTemplateManagementModal } from "../row-templates";
import { DatabaseTableView } from "../table";
import { DatabaseTimelineView } from "../timeline";
import {
  databaseFilterOperators,
  databaseFilterValueLabel,
  databaseTimelineZoomLabel,
  databaseTimelineGroupLabel,
  type DatabaseViewControlSection,
  KanbanSetupModal,
  openDatabaseDialogAfterMenuClose,
  ProgressSetupModal,
  ViewSettingsModal,
} from "../view-controls";
import {
  DatabasePageWorkbenchContextBridge,
  type DatabasePageWorkbenchContextHandle,
  type DatabaseWorkbenchContextSection,
} from "../workbench-context";
import type { DatabaseViewHostProps } from "./contracts";
import { databaseScheduleNavigationDate } from "../shared/schedule";
import { useDatabaseViewHostController } from "./controller";
import { useMutateQueryResource } from "@myoxus/core/components/hooks/use-mutation";
import { databaseChangeImpact } from "../shared/change-invalidation";
import { DatabaseViewTabs } from "./view-tabs";

function DatabaseViewHostLayout(props: DatabaseViewHostProps) {
  const t = useI18n();
  const {
    databaseId,
    layout = "page",
    onActiveViewChange,
    onChanged,
    onExportCsvRows,
    onOpenDoc,
    onScheduleChanged = onChanged,
    onScheduleDateChange,
    pagination,
    record,
    renderPageHeader,
    rowTemplates = [],
    rows,
    rowGroups,
    rowsError,
    rowsLoading = false,
    rowsScheduleDate,
    rowsScheduleView,
    onRowsRetry,
    scheduleDate = new Date().toISOString().slice(0, 10),
    workspaceId,
  } = props;
  const {
    activeFilterCount,
    activeFilterEntries,
    activeSort,
    activeView,
    addCalendarView,
    addGalleryView,
    addGanttView,
    addKanbanView,
    addListView,
    addProgressView,
    addTableView,
    addTimelineView,
    applyProgressGroupFilter,
    clearFilters,
    changeScheduleZoom,
    closeRowDetail,
    taskNavigation,
    configuredField,
    copyViewLink,
    deleteDatabaseView,
    deleteProgressRow,
    detailFallbackFocusRef,
    detailReturnFocusRef,
    detailRow,
    detailRowId,
    detailRowLoadState,
    onDetailChanged,
    effectiveState,
    effectiveStateQuery,
    fieldSettingsReturnFocusRef,
    flushSearch,
    hasPersonalChanges,
    hasPersonalQueryChanges,
    kanbanSetupTarget,
    navigationViews,
    openViewControl,
    presence,
    primaryAction,
    progressSetupOpen,
    registerPrimaryAction,
    removeActiveFilter,
    renameView,
    reorderDatabaseViews,
    resetForMe,
    resetPersonalState,
    rowDetailContext,
    rowTemplateManagementOpen,
    saveForView,
    savePersonalState,
    scheduleSearch,
    searchDraft,
    setConfiguredField,
    setKanbanSetupTarget,
    setProgressSetupOpen,
    setRowTemplateManagementOpen,
    setViewControlSection,
    setViewEditScope,
    tabVariant,
    toggleCollapsedGroup,
    updateEffectivePrimarySort,
    updateView,
    viewActionsTriggerRef,
    viewControlReturnFocusRef,
    viewControlSection,
    viewEditScope,
    workspaceTags,
  } = useDatabaseViewHostController(props, t);
  const capabilities = databaseManagedCapabilities(record);
  const scheduleDateInputRef = useRef<HTMLInputElement>(null);
  const databaseContextRef = useRef<DatabasePageWorkbenchContextHandle>(null);

  const openDatabaseContext = useCallback(
    (section: DatabaseWorkbenchContextSection) => {
      databaseContextRef.current?.open(section);
    },
    [],
  );

  const openSettings = useCallback(
    (section: DatabaseViewControlSection, trigger: HTMLElement | null) => {
      if (layout === "embedded") {
        openViewControl(section, trigger);
        return;
      }
      openDatabaseContext(section);
    },
    [layout, openDatabaseContext, openViewControl],
  );
  const viewNavigation = (
    <DatabaseViewTabs
      activeViewId={activeView.id}
      canDeleteView={record.views.length > 1}
      canEditStructure={capabilities.canEditStructure}
      createTriggerRef={viewActionsTriggerRef}
      detailFallbackFocusRef={detailFallbackFocusRef}
      labels={{
        addCalendar: t["com.myoxus.database.view.add-calendar"](),
        addGallery: t["com.myoxus.database.view.add-gallery"](),
        addGantt: t["com.myoxus.database.view.gantt"](),
        addKanban: t["com.myoxus.database.view.add-kanban"](),
        addList: t["com.myoxus.database.view.add-list"](),
        addProgress: t["com.myoxus.database.view.add-progress"](),
        addTable: t["com.myoxus.database.view.add-table"](),
        addTimeline: t["com.myoxus.database.view.add-timeline"](),
        cancel: t["Cancel"](),
        copyLink: t["com.myoxus.database.view.copy-link"](),
        create: t["com.myoxus.database.view.create"](),
        delete: t["com.myoxus.database.view.delete"](),
        more: t["com.myoxus.database.view.more"](),
        rename: t["Rename"](),
        reorderInstruction: t["com.myoxus.database.view.reorder-instruction"](),
        reorderAnnouncement: (name, position, total) =>
          t["com.myoxus.database.view.reorder-announcement"]({
            name,
            position: String(position),
            total: String(total),
          }),
        viewActions: (name) =>
          `${t["com.myoxus.database.view.actions"]()}: ${name}`,
      }}
      onCopyLink={(view) => copyViewLink(view.id)}
      onCreateCalendar={addCalendarView}
      onCreateGallery={addGalleryView}
      onCreateGantt={addGanttView}
      onCreateKanban={addKanbanView}
      onCreateList={addListView}
      onCreateProgress={addProgressView}
      onCreateTable={addTableView}
      onCreateTimeline={addTimelineView}
      onDelete={deleteDatabaseView}
      onRename={renameView}
      onReorder={reorderDatabaseViews}
      onViewChange={onActiveViewChange}
      variant={tabVariant}
      views={navigationViews}
    />
  );
  return (
    <ContextDocumentAssistance
      databaseId={databaseId}
      title={record.database.title}
      projectId={capabilities.workspaceTasks ? undefined : databaseId}
      enabled={layout === "page" && capabilities.managed && capabilities.ready}
      onShow={() => openDatabaseContext("assistance")}
      onClose={() => databaseContextRef.current?.close()}
    >
      {({ menu, content, available }) => (
        <DatabaseRowDetailContext.Provider value={rowDetailContext}>
          <Tabs
            value={activeView.id}
            onValueChange={(value) => {
              onActiveViewChange(value);
            }}
            layout={layout}
            fill={layout === "page"}
            // Only the selected view may render the active query's row window.
            keepMounted={false}
            data-testid={
              layout === "embedded"
                ? "database-embedded-editor"
                : "database-detail"
            }
          >
            {layout === "page" && renderPageHeader
              ? renderPageHeader(
                  viewNavigation,
                  menu({
                    databaseId,
                    title: record.database.title,
                    projectId: capabilities.workspaceTasks
                      ? undefined
                      : databaseId,
                    returnFocusRef: props.assistanceReturnFocusRef,
                  }),
                )
              : null}
            <Stack gap="xs">
              {layout === "embedded" || !renderPageHeader
                ? viewNavigation
                : null}
              <Group
                align="flex-start"
                gap="xs"
                justify="space-between"
                wrap="wrap"
                data-testid={
                  activeView.viewKind === DatabaseViewKind.Kanban
                    ? "database-kanban-toolbar"
                    : undefined
                }
              >
                <Group gap="xs" wrap="wrap" data-testid="database-view-toolbar">
                  {(activeView.viewKind === DatabaseViewKind.Progress ||
                    [
                      DatabaseViewKind.Gantt,
                      DatabaseViewKind.Timeline,
                    ].includes(activeView.viewKind)) &&
                  primaryAction ? (
                    <Button
                      size="sm"
                      prefix={<PlusIcon />}
                      disabled={primaryAction.disabled}
                      tooltip={primaryAction.disabledReason}
                      data-testid={
                        activeView.viewKind === DatabaseViewKind.Gantt
                          ? "database-gantt-add-row"
                          : activeView.viewKind === DatabaseViewKind.Timeline
                            ? "database-timeline-add-row"
                            : "database-progress-global-add-task"
                      }
                      onClick={primaryAction.onSelect}
                    >
                      {primaryAction.label}
                    </Button>
                  ) : null}
                  {(activeView.viewKind === DatabaseViewKind.Table &&
                    activeView.config.table?.searchFieldIds.length) ||
                  [DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
                    activeView.viewKind,
                  ) ? (
                    <Input
                      aria-label={t["Quick search"]()}
                      data-testid={
                        activeView.viewKind === DatabaseViewKind.Gantt
                          ? "database-gantt-search"
                          : activeView.viewKind === DatabaseViewKind.Timeline
                            ? "database-timeline-search"
                            : "database-table-search"
                      }
                      preFix={<SearchIcon />}
                      placeholder={t["Quick search"]()}
                      endFix={
                        searchDraft ? (
                          <IconButton
                            aria-label={t[
                              "com.myoxus.database.view.clear-search"
                            ]()}
                            size="small"
                            variant="plain"
                            onClick={() => scheduleSearch("", true)}
                          >
                            <CloseIcon />
                          </IconButton>
                        ) : null
                      }
                      rightSectionPointerEvents="auto"
                      type="search"
                      value={searchDraft}
                      onBlur={flushSearch}
                      onChange={scheduleSearch}
                    />
                  ) : null}
                  {layout === "page" &&
                  ![DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
                    activeView.viewKind,
                  ) ? (
                    <IconButton
                      aria-label={t["com.myoxus.database.view.settings"]()}
                      tooltip={t["com.myoxus.database.view.settings"]()}
                      data-testid="database-context-settings-trigger"
                      onClick={() => openDatabaseContext("fields")}
                    >
                      <SettingsIcon />
                    </IconButton>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant={activeFilterCount ? "secondary" : "default"}
                        prefix={<FilterIcon />}
                        onClick={(event) =>
                          openSettings("filter", event.currentTarget)
                        }
                      >
                        {activeFilterCount
                          ? t["com.myoxus.database.view.filter-active"]({
                              count: String(activeFilterCount),
                            })
                          : t["com.myoxus.filter"]()}
                      </Button>
                      <Button
                        size="sm"
                        variant={activeSort.length ? "secondary" : "default"}
                        prefix={<SortIcon />}
                        onClick={(event) =>
                          openSettings("sort", event.currentTarget)
                        }
                      >
                        {activeSort.length
                          ? t["com.myoxus.database.view.sort-active"]({
                              count: String(activeSort.length),
                              field:
                                getFieldById(record, activeSort[0]?.fieldId)
                                  ?.name ?? "",
                            })
                          : t["com.myoxus.database.view.sort-field"]()}
                      </Button>
                      {activeView.viewKind === DatabaseViewKind.Kanban ||
                      [
                        DatabaseViewKind.Calendar,
                        DatabaseViewKind.Gallery,
                        DatabaseViewKind.Gantt,
                        DatabaseViewKind.Timeline,
                        DatabaseViewKind.List,
                        DatabaseViewKind.Table,
                      ].includes(activeView.viewKind) ? (
                        <Button
                          size="sm"
                          variant="default"
                          prefix={<GroupingIcon />}
                          onClick={(event) =>
                            openSettings(
                              activeView.viewKind === DatabaseViewKind.Timeline
                                ? "display"
                                : "group",
                              event.currentTarget,
                            )
                          }
                        >
                          {activeView.viewKind === DatabaseViewKind.Timeline
                            ? `${t["com.myoxus.database.view.timeline-group"]()}: ${databaseTimelineGroupLabel(t, activeView.config.timeline?.groupBy ?? DatabaseTimelineGroupBy.None)}`
                            : getViewGroupRules(activeView).group
                              ? `${t["com.myoxus.page.display.grouping"]()}: ${getFieldById(record, getViewGroupRules(activeView).group!.fieldId)?.name ?? ""}`
                              : t["com.myoxus.page.display.grouping"]()}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="default"
                        prefix={<PropertyIcon />}
                        onClick={(event) =>
                          openSettings("fields", event.currentTarget)
                        }
                      >
                        {t["com.myoxus.database.fields"]()}
                      </Button>
                      {activeView.viewKind === DatabaseViewKind.Kanban ? (
                        <Button
                          size="sm"
                          variant="default"
                          prefix={<SettingsIcon />}
                          onClick={(event) =>
                            openSettings("display", event.currentTarget)
                          }
                          data-testid="database-kanban-layout"
                        >
                          {t["com.myoxus.page.display"]()}
                        </Button>
                      ) : null}
                    </>
                  )}
                  {[DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
                    activeView.viewKind,
                  ) ? (
                    <>
                      <Button
                        onClick={() =>
                          onScheduleDateChange?.(
                            databaseScheduleNavigationDate(
                              activeView,
                              scheduleDate,
                              -1,
                            ),
                          )
                        }
                        disabled={!onScheduleDateChange}
                      >
                        {t["common.previous"]()}
                      </Button>
                      <Button
                        onClick={() =>
                          onScheduleDateChange?.(
                            new Date().toISOString().slice(0, 10),
                          )
                        }
                        disabled={!onScheduleDateChange}
                      >
                        {t["com.myoxus.today"]()}
                      </Button>
                      <Button
                        onClick={() =>
                          onScheduleDateChange?.(
                            databaseScheduleNavigationDate(
                              activeView,
                              scheduleDate,
                              1,
                            ),
                          )
                        }
                        disabled={!onScheduleDateChange}
                      >
                        {t["common.next"]()}
                      </Button>
                      <LocalizedDateInput
                        ref={scheduleDateInputRef}
                        data-testid="database-schedule-date"
                        aria-label={t["Date"]()}
                        locale={t.language}
                        value={scheduleDate}
                        disabled={!onScheduleDateChange}
                        onChange={(value) => {
                          if (value) onScheduleDateChange?.(value);
                        }}
                      />
                      <Select
                        aria-label={t["com.myoxus.database.schedule.zoom"]()}
                        data={Object.values(DatabaseTimelineZoom).map(
                          (value) => ({
                            value,
                            label: databaseTimelineZoomLabel(t, value),
                          }),
                        )}
                        value={
                          (activeView.viewKind === DatabaseViewKind.Timeline
                            ? activeView.config.timeline?.zoom
                            : activeView.config.gantt?.zoom) ??
                          DatabaseTimelineZoom.Month
                        }
                        disabled={
                          !effectiveState.canEditShared || updateView.isMutating
                        }
                        onChange={(value) => {
                          if (value)
                            void changeScheduleZoom(
                              value as DatabaseTimelineZoom,
                            ).catch(() =>
                              notify.error({
                                title:
                                  t["com.myoxus.common.operation-failed"](),
                              }),
                            );
                        }}
                      />
                    </>
                  ) : null}
                </Group>
                <Group
                  align="center"
                  gap="xs"
                  wrap="wrap"
                  data-testid="database-view-context-toolbar"
                >
                  {rowsLoading &&
                  [DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
                    activeView.viewKind,
                  ) ? (
                    <Loading />
                  ) : null}
                  {pagination}
                </Group>
              </Group>
              {layout === "embedded" && hasPersonalChanges ? (
                <Group
                  gap="xs"
                  wrap="wrap"
                  data-testid="database-personal-changes"
                >
                  <Badge tone="info">
                    {t["com.myoxus.database.view.personal-changes"]()}
                  </Badge>
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={resetPersonalState.isMutating}
                    onClick={() => void resetForMe()}
                  >
                    {t["com.myoxus.database.view.reset-for-me"]()}
                  </Button>
                  {effectiveState.canEditShared && hasPersonalQueryChanges ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      loading={savePersonalState.isMutating}
                      onClick={() => void saveForView()}
                    >
                      {t["com.myoxus.database.view.save-to-view"]()}
                    </Button>
                  ) : null}
                </Group>
              ) : null}
              {activeFilterEntries.length ? (
                <FilterBar
                  aria-label={t["com.myoxus.filter"]()}
                  data-testid="database-active-filter-bar"
                >
                  {activeFilterEntries.map((entry, index) => {
                    const rule: DatabaseFilterRuleInput = {
                      fieldId: entry.rule.fieldId,
                      operator: entry.rule.operator,
                      value: databaseFilterValueInputFromOutput(
                        entry.rule.value,
                      ),
                    };
                    const field = getFieldById(record, rule.fieldId);
                    if (!field) return null;
                    const operator = databaseFilterOperators(t, field).find(
                      (candidate) => candidate.value === rule.operator,
                    );
                    const value = databaseFilterValueLabel(
                      field,
                      rule,
                      workspaceTags,
                      rows,
                    );
                    const scopeLabel = entry.depth
                      ? t["com.myoxus.database.filter.nested-group"]({
                          depth: String(entry.depth),
                        })
                      : entry.conjunction === DatabaseFilterConjunction.And
                        ? t["com.myoxus.database.filter.all"]()
                        : t["com.myoxus.database.filter.any"]();
                    const chipLabel = [
                      scopeLabel,
                      field.name,
                      operator?.label ?? t["com.myoxus.filter.is"](),
                      value,
                    ]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <FilterChip
                        key={`${entry.groupPath.join(".")}:${entry.ruleIndex}:${rule.fieldId}:${index}`}
                        active
                      >
                        <FilterChipTrigger
                          onClick={(event) =>
                            openSettings("filter", event.currentTarget)
                          }
                        >
                          <FilterChipSegment tone="secondary">
                            {chipLabel}
                          </FilterChipSegment>
                        </FilterChipTrigger>
                        <IconButton
                          aria-label={`${t["Delete"]()}: ${field.name}`}
                          size="small"
                          variant="plain"
                          onClick={() =>
                            void removeActiveFilter(
                              entry.groupPath,
                              entry.ruleIndex,
                            )
                          }
                        >
                          <CloseIcon />
                        </IconButton>
                      </FilterChip>
                    );
                  })}
                  <Button
                    variant="ghost"
                    onClick={() => void clearFilters()}
                    loading={updateView.isMutating}
                  >
                    {t["com.myoxus.database.view.clear-filters"]()}
                  </Button>
                </FilterBar>
              ) : null}
            </Stack>
            {rowsError &&
            [DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
              activeView.viewKind,
            ) ? (
              <Alert data-testid={`database-rows-${rowsError}`}>
                <Group>
                  <MyoxusText>
                    {rowsError === "offline"
                      ? t["com.myoxus.database.embed.offline"]()
                      : t["com.myoxus.database.embed.unavailable"]()}
                  </MyoxusText>
                  {onRowsRetry ? (
                    <Button onClick={onRowsRetry}>{t["Retry"]()}</Button>
                  ) : null}
                </Group>
              </Alert>
            ) : null}
            {/* Schedule refresh must not unmount drafts or focus targets.
            The loader retains its last complete server snapshot until readback. */}
            {rowsLoading &&
            ![DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
              activeView.viewKind,
            ) ? (
              <Group justify="center" data-testid="database-rows-loading">
                <Loading />
              </Group>
            ) : rowsError &&
              ![DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
                activeView.viewKind,
              ) ? (
              <Group data-testid={`database-rows-${rowsError}`}>
                <MyoxusText>
                  {rowsError === "offline"
                    ? t["com.myoxus.database.embed.offline"]()
                    : t["com.myoxus.database.embed.unavailable"]()}
                </MyoxusText>
                {onRowsRetry ? (
                  <Button variant="secondary" onClick={onRowsRetry}>
                    {t["Retry"]()}
                  </Button>
                ) : null}
              </Group>
            ) : (
              sortByPosition(record.views).map((view) => (
                <TabsContent
                  key={view.id}
                  value={view.id}
                  fill={layout === "page"}
                  layout="stack"
                  scroll={layout === "page"}
                >
                  {view.viewKind === DatabaseViewKind.Kanban ? (
                    <DatabaseKanbanView
                      databaseId={databaseId}
                      onConfigure={
                        effectiveState.canEditShared
                          ? () => setKanbanSetupTarget({ kind: "update", view })
                          : undefined
                      }
                      record={record}
                      rows={rows}
                      rowTemplates={rowTemplates}
                      view={view}
                      onChanged={onChanged}
                      onConfigureGroupField={
                        effectiveState.canEditShared
                          ? (field, trigger) => {
                              fieldSettingsReturnFocusRef.current = trigger;
                              setConfiguredField(field);
                            }
                          : undefined
                      }
                    />
                  ) : view.viewKind === DatabaseViewKind.List ? (
                    <DatabaseListView
                      databaseId={databaseId}
                      record={record}
                      rows={rows}
                      view={view}
                      onChanged={onChanged}
                    />
                  ) : view.viewKind === DatabaseViewKind.Gallery ? (
                    <DatabaseGalleryView
                      databaseId={databaseId}
                      record={record}
                      rows={rows}
                      view={view}
                      onChanged={onChanged}
                    />
                  ) : view.viewKind === DatabaseViewKind.Calendar ? (
                    <DatabaseCalendarView
                      date={scheduleDate}
                      record={record}
                      rows={rows}
                      view={view}
                      onDateChange={onScheduleDateChange ?? (() => undefined)}
                    />
                  ) : view.viewKind === DatabaseViewKind.Gantt ? (
                    <DatabaseGanttView
                      onToolbarActionChange={
                        view.id === activeView.id
                          ? registerPrimaryAction
                          : undefined
                      }
                      canEdit={effectiveState.canEditRows}
                      loading={rowsLoading}
                      hasActiveQuery={Boolean(
                        searchDraft.trim() || activeFilterCount,
                      )}
                      onConfigureFields={
                        effectiveState.canEditShared
                          ? () =>
                              openSettings(
                                "fields",
                                document.activeElement instanceof HTMLElement
                                  ? document.activeElement
                                  : null,
                              )
                          : undefined
                      }
                      onClearQuery={() => {
                        scheduleSearch("");
                        void clearFilters();
                      }}
                      onShowToday={() =>
                        onScheduleDateChange?.(
                          new Date().toISOString().slice(0, 10),
                        )
                      }
                      databaseId={databaseId}
                      date={rowsScheduleDate ?? scheduleDate}
                      onChanged={onScheduleChanged}
                      record={record}
                      rows={
                        rowsScheduleView && rowsScheduleView.id !== view.id
                          ? []
                          : rows
                      }
                      rowGroups={
                        rowsScheduleView && rowsScheduleView.id !== view.id
                          ? undefined
                          : rowGroups
                      }
                      collapsedGroupKeys={
                        effectiveState.personalState?.collapsedGroupKeys
                      }
                      onToggleGroup={(key, collapsed) =>
                        void toggleCollapsedGroup(key, collapsed).catch(() =>
                          notify.error({
                            title: t["com.myoxus.common.operation-failed"](),
                          }),
                        )
                      }
                      view={
                        rowsScheduleView?.id === view.id
                          ? rowsScheduleView
                          : view
                      }
                    />
                  ) : view.viewKind === DatabaseViewKind.Timeline ? (
                    <DatabaseTimelineView
                      workspaceId={workspaceId}
                      search={searchDraft.trim()}
                      activeFilterCount={activeFilterCount}
                      onToolbarActionChange={
                        view.id === activeView.id
                          ? registerPrimaryAction
                          : undefined
                      }
                      requestedView={view}
                      requestedDate={scheduleDate}
                      canEdit={effectiveState.canEditRows}
                      hasActiveQuery={Boolean(
                        searchDraft.trim() || activeFilterCount,
                      )}
                      onClearQuery={() => {
                        scheduleSearch("", true);
                        void clearFilters();
                      }}
                      onShowToday={() =>
                        onScheduleDateChange?.(
                          new Date().toISOString().slice(0, 10),
                        )
                      }
                      onChooseDate={() => scheduleDateInputRef.current?.focus()}
                      databaseId={databaseId}
                      date={rowsScheduleDate ?? scheduleDate}
                      onChanged={onScheduleChanged}
                      record={record}
                      rows={
                        rowsScheduleView && rowsScheduleView.id !== view.id
                          ? []
                          : rows
                      }
                      view={
                        rowsScheduleView?.id === view.id
                          ? rowsScheduleView
                          : view
                      }
                      loading={rowsLoading}
                      onConfigureFields={
                        effectiveState.canEditShared
                          ? () =>
                              openSettings(
                                "fields",
                                document.activeElement instanceof HTMLElement
                                  ? document.activeElement
                                  : null,
                              )
                          : undefined
                      }
                    />
                  ) : view.viewKind === DatabaseViewKind.Progress ? (
                    <DatabaseProgressView
                      canEdit={effectiveState.canEditRows}
                      databaseId={databaseId}
                      effectiveQueryRevision={`${view.editRevision}:${effectiveState.personalState?.editRevision ?? 0}`}
                      record={record}
                      rows={rows}
                      rowTemplates={rowTemplates}
                      view={view}
                      workspaceId={workspaceId}
                      onChanged={onChanged}
                      onApplyGroupFilter={applyProgressGroupFilter}
                      onToolbarActionChange={
                        view.id === activeView.id
                          ? registerPrimaryAction
                          : undefined
                      }
                      renderRowState={(row) => (
                        <DatabaseRowStateBadges row={row} />
                      )}
                      renderRowPanel={(row, visibleFields) => (
                        <Stack gap="sm">
                          <DatabaseViewFieldValues
                            databaseId={databaseId}
                            fields={visibleFields}
                            onChanged={onChanged}
                            record={record}
                            row={row}
                            rows={rows}
                            showLabels
                          />
                          <Group justify="flex-end">
                            <DatabaseRowActionMenu
                              record={record}
                              onChanged={onChanged}
                              canEdit={effectiveState.canEditRows}
                              row={row}
                              onDelete={() => void deleteProgressRow(row)}
                            />
                          </Group>
                        </Stack>
                      )}
                    />
                  ) : (
                    <DatabaseTableView
                      databaseId={databaseId}
                      effectiveSort={activeSort.map((rule) => ({
                        direction: rule.direction,
                        fieldId: rule.fieldId,
                      }))}
                      emptyRowsLabel={
                        view.id === activeView.id &&
                        (Boolean(effectiveState.searchText.trim()) ||
                          activeFilterCount > 0)
                          ? t["com.myoxus.database.row.no-matches"]()
                          : undefined
                      }
                      onConfigureField={(field, trigger) => {
                        fieldSettingsReturnFocusRef.current = trigger;
                        openDatabaseDialogAfterMenuClose(() =>
                          setConfiguredField(field),
                        );
                      }}
                      onExportCsvRows={onExportCsvRows}
                      record={record}
                      rows={rows}
                      view={view}
                      onChanged={onChanged}
                      rowTemplates={rowTemplates}
                      onOpenRowTemplateManagement={() =>
                        layout === "page"
                          ? openDatabaseContext("templates")
                          : setRowTemplateManagementOpen(true)
                      }
                      onUpdateSort={updateEffectivePrimarySort}
                    />
                  )}
                </TabsContent>
              ))
            )}
          </Tabs>
          {layout === "page" ? (
            <>
              <ActivePeopleTool
                connected={presence.connected}
                people={presence.collaborators.map((person) => ({
                  key: person.socketId,
                  name: person.displayName,
                  local: person.socketId === presence.localSocketId,
                }))}
              />
              <DatabasePageWorkbenchContextBridge
                ref={databaseContextRef}
                assistance={content}
                taskAssistanceAvailable={available}
                activeView={activeView}
                databaseId={databaseId}
                effectiveState={effectiveState}
                canManageContent={Boolean(
                  effectiveStateQuery.data.workspace?.databaseEffectiveViewState
                    ?.canEditShared,
                )}
                editScope={viewEditScope}
                hasPersonalChanges={hasPersonalChanges}
                hasPersonalQueryChanges={hasPersonalQueryChanges}
                onChanged={onChanged}
                onConfigureField={(field, trigger) => {
                  fieldSettingsReturnFocusRef.current = trigger;
                  setConfiguredField(field);
                }}
                onCopyViewLink={() => void copyViewLink(activeView.id)}
                onEditScopeChange={setViewEditScope}
                onEffectiveStateChanged={async () => {
                  await effectiveStateQuery.mutate();
                }}
                onRenameView={(name) => renameView(activeView, name)}
                onResetForMe={resetForMe}
                onSaveForView={saveForView}
                record={record}
                resettingPersonalState={resetPersonalState.isMutating}
                rowTemplates={rowTemplates}
                rows={rows}
                savingPersonalState={savePersonalState.isMutating}
                workspaceId={workspaceId}
              />
            </>
          ) : null}
          <TaskDetailNavigationContext.Provider value={taskNavigation}>
            <DatabaseRowDetailPeek
              canEdit={effectiveState.canEditRows}
              databaseId={databaseId}
              loadState={detailRowId ? detailRowLoadState : null}
              onChanged={onDetailChanged}
              onClose={closeRowDetail}
              onDelete={deleteProgressRow}
              onOpenDoc={onOpenDoc}
              record={record}
              returnFocusRef={detailReturnFocusRef}
              row={detailRow}
              rows={rows}
              viewId={activeView.id}
              workspaceId={workspaceId}
            />
          </TaskDetailNavigationContext.Provider>
          {layout === "embedded" ? (
            <ViewSettingsModal
              databaseId={databaseId}
              effectiveState={effectiveState}
              editScope={viewEditScope}
              open={viewControlSection !== null}
              onClose={() => setViewControlSection(null)}
              onEditScopeChange={setViewEditScope}
              onEffectiveStateChanged={async () => {
                await effectiveStateQuery.mutate();
              }}
              onChanged={onChanged}
              record={record}
              returnFocusRef={viewControlReturnFocusRef}
              section={viewControlSection ?? "fields"}
              view={activeView}
            />
          ) : null}
          <KanbanSetupModal
            databaseId={databaseId}
            onActiveViewChange={onActiveViewChange}
            onChanged={onChanged}
            onClose={() => setKanbanSetupTarget(null)}
            record={record}
            returnFocusRef={viewActionsTriggerRef}
            target={kanbanSetupTarget}
          />
          <ProgressSetupModal
            databaseId={databaseId}
            onActiveViewChange={onActiveViewChange}
            onChanged={onChanged}
            onClose={() => setProgressSetupOpen(false)}
            open={progressSetupOpen}
            record={record}
            returnFocusRef={viewActionsTriggerRef}
          />
          {layout === "embedded" ? (
            <RowTemplateManagementModal
              databaseId={databaseId}
              open={rowTemplateManagementOpen}
              onClose={() => setRowTemplateManagementOpen(false)}
              onChanged={onChanged}
              record={record}
              rowTemplates={rowTemplates}
              rows={rows}
            />
          ) : null}
          {capabilities.canEditStructure ? (
            <FieldSettingsModal
              databaseId={databaseId}
              field={
                configuredField?.fieldType === DatabaseFieldKind.Status
                  ? (record.fields.find(
                      (field) => field.id === configuredField.id,
                    ) ?? null)
                  : configuredField
              }
              onClose={() => setConfiguredField(null)}
              onChanged={onChanged}
              returnFocusRef={fieldSettingsReturnFocusRef}
            />
          ) : null}
        </DatabaseRowDetailContext.Provider>
      )}
    </ContextDocumentAssistance>
  );
}

/**
 * Shared conflict boundary for standalone pages and server-backed embeds. All
 * descendant mutation paths therefore expose the same explicit reload/force
 * contract instead of implementing per-view conflict behavior.
 */
export function DatabaseViewHost(props: DatabaseViewHostProps) {
  const t = useI18n();
  const revalidate = useMutateQueryResource();
  const socket = useDatabaseSocket();
  const presence = useDatabasePresence({
    socket,
    workspaceId: props.workspaceId,
    databaseId: props.databaseId,
    onChange: (event) => {
      void (async () => {
        if (props.onRemoteChange) await props.onRemoteChange(event);
        else await props.onChanged();
        // Page already invalidates linked Rows. Embed owns its window loader,
        // so refresh only its active canonical peek cache, never another Row list.
        if (
          props.layout === "embedded" &&
          databaseChangeImpact(event).linkedRow
        ) {
          await revalidate(
            databaseRowQuery,
            (vars) =>
              vars.workspaceId === props.workspaceId &&
              vars.databaseId === props.databaseId &&
              (!event.target?.rowId || vars.rowId === event.target.rowId),
          );
        }
      })().catch(() =>
        notify.error({ title: t["com.myoxus.common.operation-failed"]() }),
      );
    },
  });
  const capabilities = databaseManagedCapabilities(props.record);
  if (!capabilities.ready)
    return (
      <Notice
        tone="warning"
        title={managedTaskUnavailableLabel(
          t,
          props.record.managedSchema?.reasonCode,
        )}
      >
        <Button onClick={() => void props.onChanged()}>{t.Retry()}</Button>
      </Notice>
    );
  return (
    <DatabaseConflictProvider>
      <DatabasePresenceProvider value={presence}>
        <DatabaseViewHostLayout {...props} />
      </DatabasePresenceProvider>
    </DatabaseConflictProvider>
  );
}
