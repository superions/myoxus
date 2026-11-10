// SPDX-License-Identifier: AGPL-3.0-or-later

import { databaseManagedCapabilities } from "../managed";

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { useQuery } from "@myoxus/core/components/hooks/use-query";
import { GraphQLService } from "@myoxus/core/modules/server";
import { TagService } from "@myoxus/core/modules/tag/service/tag";
import {
  createDatabaseViewMutation,
  databaseEffectiveViewStateQuery,
  databaseRowQuery,
  databaseViewQuery,
  type UpdateDatabaseViewMutationVariables,
  type DatabaseFilterGroupInput,
  DatabaseSortDirection,
  DatabaseTimelineZoom,
  type DatabaseSortRuleInput,
  DatabaseViewKind,
  deleteDatabaseViewMutation,
  reorderDatabaseViewsMutation,
  resetDatabaseViewUserStateMutation,
  saveDatabaseViewUserStateMutation,
  updateDatabaseViewMutation,
  upsertDatabaseViewUserStateMutation,
} from "@myoxus/graphql";
import type { I18nInstance } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createCalendarViewConfigInput,
  createGalleryViewConfigInput,
  createGanttViewConfigInput,
  createListViewConfigInput,
  createTableViewConfigInput,
  createTimelineViewConfigInput,
  createViewConfigInputFromEdits,
  databaseFilterGroupInputFromOutput,
  getPrimaryView,
  proposeDatabaseViewName,
  sortByPosition,
} from "../model";
import {
  useDatabaseConflictController,
  useDatabasePresenceContext,
} from "../presence";
import {
  executeRevisionMutation,
  executeNonForceableRevisionMutation,
} from "../presence/execute-revision-mutation";
import {
  type DatabaseRowDetailContextValue,
  type DatabaseRowDetailLoadState,
  useDeleteDatabaseRowAction,
} from "../row-detail";
import { classifyDatabaseError } from "../route-state";
import { useTaskDetailNavigation } from "../row-detail/task-navigation";
import { useTaskIdentity } from "../tasks/use-workspace-tasks";
import type { DatabaseChangeHandler } from "../shared/change-invalidation";
import type { DatabaseViewPrimaryAction } from "../shared";
import { getFirstDatabaseDateField } from "../shared";
import type { DatabaseField } from "../types";
import {
  applyDatabaseProgressGroupFilter,
  collectDatabaseFilterRules,
  createDatabaseFilterGroup,
  databaseProgressGroupFilterRule,
  databaseTimelineZoomLabel,
  type DatabaseViewControlSection,
  type DatabaseViewEditScope,
  type KanbanSetupTarget,
  removeDatabaseFilterRule,
} from "../view-controls";
import type { DatabaseViewHostProps } from "./contracts";

export function useDatabaseViewHostController(
  props: DatabaseViewHostProps,
  t: I18nInstance,
) {
  const {
    activeViewId,
    databaseId,
    initialRowId = null,
    initialRowLoadState = null,
    ownerAdmissionPending = false,
    layout = "page",
    onActiveViewChange,
    onChanged,
    onCopyRowLink,
    onCopyViewLink,
    onRowDetailChange,
    onSearchChange,
    record,
    rows,
    workspaceId,
  } = props;

  const conflicts = useDatabaseConflictController();

  const presence = useDatabasePresenceContext();

  const deleteProgressRow = useDeleteDatabaseRowAction(databaseId, onChanged);

  const [viewControlSection, setViewControlSection] =
    useState<DatabaseViewControlSection | null>(null);

  const [viewEditScope, setViewEditScope] =
    useState<DatabaseViewEditScope>("shared");

  const [kanbanSetupTarget, setKanbanSetupTarget] =
    useState<KanbanSetupTarget | null>(null);

  const [progressSetupOpen, setProgressSetupOpen] = useState(false);

  const [rowTemplateManagementOpen, setRowTemplateManagementOpen] =
    useState(false);

  const [configuredField, setConfiguredField] = useState<DatabaseField | null>(
    null,
  );

  const [detailRowId, setDetailRowId] = useState<string | null>(initialRowId);
  const taskOwner = useTaskIdentity();
  const { navigation: taskNavigation, reset: resetTaskNavigation } =
    useTaskDetailNavigation(
      taskOwner.identity ? `${taskOwner.identity}:${databaseId}` : null,
      detailRowId,
      (rowId) => {
        setDetailRowId(rowId);
        onRowDetailChange?.(rowId);
      },
    );

  const [primaryAction, setPrimaryAction] =
    useState<DatabaseViewPrimaryAction | null>(null);

  const viewActionsTriggerRef = useRef<HTMLButtonElement>(null);

  const viewControlReturnFocusRef = useRef<HTMLElement | null>(null);

  const fieldSettingsReturnFocusRef = useRef<HTMLElement | null>(null);

  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const detailFallbackFocusRef = useRef<HTMLButtonElement | null>(null);

  const primaryActionHandlerRef = useRef<(() => void) | null>(null);

  // The shared SWR notification owns failures; a rejected create must not
  // become an unhandled menu callback or activate a nonexistent view.
  const createView = useMutation(
    { mutation: createDatabaseViewMutation },
    { throwOnError: false },
  );

  const deleteView = useMutation({
    mutation: deleteDatabaseViewMutation,
  });

  const updateView = useMutation({
    mutation: updateDatabaseViewMutation,
  });
  const triggerUpdateView = updateView.trigger;

  const reorderViews = useMutation({
    mutation: reorderDatabaseViewsMutation,
  });

  const upsertPersonalState = useMutation({
    mutation: upsertDatabaseViewUserStateMutation,
  });

  const resetPersonalState = useMutation({
    mutation: resetDatabaseViewUserStateMutation,
  });

  const savePersonalState = useMutation({
    mutation: saveDatabaseViewUserStateMutation,
  });

  const tagService = useService(TagService);
  const graphqlService = useService(GraphQLService);

  const workspaceTags = useLiveData(tagService.tagList.tagMetas$);

  const activeView = getPrimaryView(record, activeViewId);

  const [optimisticViewOrder, setOptimisticViewOrder] = useState<
    string[] | null
  >(null);
  const serverOrderedViews = sortByPosition(record.views);
  const navigationViews = optimisticViewOrder
    ? [
        ...optimisticViewOrder
          .map((viewId) =>
            serverOrderedViews.find((view) => view.id === viewId),
          )
          .filter((view): view is (typeof serverOrderedViews)[number] =>
            Boolean(view),
          ),
        ...serverOrderedViews.filter(
          (view) => !optimisticViewOrder.includes(view.id),
        ),
      ]
    : serverOrderedViews;

  const windowDetailRow = rows.find(
    (candidate) => candidate.row.id === detailRowId,
  );
  // Projection labels already come from ACL-safe relationTargets. Only an
  // explicit Open resolves an outside-window Row, through the canonical peek.
  const outsideDetailQuery = useQuery(
    detailRowId && !windowDetailRow && !ownerAdmissionPending
      ? {
          query: databaseRowQuery,
          variables: { workspaceId, databaseId, rowId: detailRowId },
        }
      : undefined,
    { suspense: false, suppressErrorNotification: true },
  );
  const queriedDetailRow = outsideDetailQuery.data?.workspace?.databaseRow;
  const candidateDetailRow = windowDetailRow ?? queriedDetailRow ?? null;
  const outsideError = outsideDetailQuery.error
    ? classifyDatabaseError(outsideDetailQuery.error)
    : null;
  // A current canonical rejection dominates older inventory/cache snapshots.
  // Loading and transport failures keep the same-owner draft surface mounted.
  const initialTerminal =
    detailRowId === initialRowId &&
    (initialRowLoadState === "forbidden" || initialRowLoadState === "missing")
      ? initialRowLoadState
      : null;
  const outsideTerminal =
    !windowDetailRow &&
    (outsideError === "forbidden" || outsideError === "missing")
      ? outsideError
      : !windowDetailRow &&
          !outsideError &&
          outsideDetailQuery.data &&
          !outsideDetailQuery.isLoading &&
          !queriedDetailRow
        ? "missing"
        : null;
  const terminalState =
    initialTerminal ??
    outsideTerminal ??
    (candidateDetailRow?.redacted
      ? "forbidden"
      : candidateDetailRow?.row.deletedAt
        ? "missing"
        : null);
  const detailRow =
    !ownerAdmissionPending && !terminalState && candidateDetailRow
      ? candidateDetailRow
      : null;
  const detailRowLoadState: DatabaseRowDetailLoadState | null =
    !detailRowId || detailRow
      ? null
      : ownerAdmissionPending
        ? "loading"
        : (terminalState ??
          (outsideError
            ? "unavailable"
            : outsideDetailQuery.isLoading
              ? "loading"
              : outsideDetailQuery.data
                ? "missing"
                : (initialRowLoadState ?? "loading")));
  const mutateOutsideDetail = outsideDetailQuery.mutate;
  const onDetailChanged = useCallback<DatabaseChangeHandler>(
    async (reason) => {
      await onChanged(reason);
      if (detailRowId && !windowDetailRow) await mutateOutsideDetail();
    },
    [detailRowId, windowDetailRow, onChanged, mutateOutsideDetail],
  );

  const effectiveStateQuery = useQuery({
    query: databaseEffectiveViewStateQuery,
    variables: {
      workspaceId,
      databaseId,
      viewId: activeView.id,
    },
  });

  const mutateEffectiveState = effectiveStateQuery.mutate;
  const effectiveViewBasisRef = useRef({
    id: activeView.id,
    revision: activeView.editRevision,
  });
  useEffect(() => {
    const previous = effectiveViewBasisRef.current;
    effectiveViewBasisRef.current = {
      id: activeView.id,
      revision: activeView.editRevision,
    };
    // Shared settings invalidate effective Sort/Filter/capability output too.
    // A Row reload alone must not leave toolbar chips on the previous config.
    if (
      previous.id === activeView.id &&
      previous.revision !== activeView.editRevision
    )
      void mutateEffectiveState().catch(() => {
        notify.error({ title: t["com.myoxus.database.view.update-failed"]() });
      });
  }, [activeView.id, activeView.editRevision, mutateEffectiveState, t]);

  const serverEffectiveState =
    effectiveStateQuery.data.workspace?.databaseEffectiveViewState;
  const capabilities = databaseManagedCapabilities(record);
  const effectiveState = useMemo(
    () =>
      serverEffectiveState
        ? {
            ...serverEffectiveState,
            canEditShared:
              serverEffectiveState.canEditShared &&
              capabilities.canEditStructure,
            canEditRows: serverEffectiveState.canEditRows && capabilities.ready,
          }
        : undefined,
    [serverEffectiveState, capabilities.canEditStructure, capabilities.ready],
  );

  if (!effectiveState) {
    throw new Error("Database effective view state is unavailable.");
  }

  const tabVariant = layout === "page" ? ("page" as const) : ("panel" as const);

  const [searchDraft, setSearchDraft] = useState(effectiveState.searchText);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchSequenceRef = useRef(0);
  const pendingSearchRef = useRef<{ value: string; sequence: number } | null>(
    null,
  );
  const personalQueueBlockedRef = useRef(false);

  const searchPersistQueueRef = useRef<Promise<void>>(Promise.resolve());

  const confirmedPersonalRef = useRef(effectiveState.personalState);
  const personalOwnerRef = useRef(activeView.id);
  const personalRevisionRef = useRef<number>(
    effectiveState.personalState?.editRevision ?? 0,
  );

  useEffect(() => {
    const personal = effectiveState.personalState;
    const ownerChanged = personalOwnerRef.current !== activeView.id;
    if (ownerChanged) {
      searchSequenceRef.current += 1;
      pendingSearchRef.current = null;
      personalQueueBlockedRef.current = false;
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    // A response to an earlier revalidation must not replace a newer server
    // acknowledgement used by the serialized Search/Collapse write queue.
    if (
      ownerChanged ||
      (personal
        ? personal.editRevision >= personalRevisionRef.current
        : personalRevisionRef.current === 0)
    ) {
      personalOwnerRef.current = activeView.id;
      confirmedPersonalRef.current = personal;
      personalRevisionRef.current = personal?.editRevision ?? 0;
      // Local typing owns its draft until this exact intent is acknowledged;
      // unrelated revalidation cannot reset it to an earlier search value.
      if (!pendingSearchRef.current) setSearchDraft(effectiveState.searchText);
    }
    if (ownerChanged || !effectiveState.canEditShared)
      setViewEditScope(effectiveState.canEditShared ? "shared" : "personal");
  }, [activeView.id, effectiveState]);

  useEffect(
    () => () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchSequenceRef.current += 1;
    },
    [],
  );

  const reloadPersonalState = useCallback(async () => {
    const latest = await effectiveStateQuery.mutate();
    const state = latest?.workspace?.databaseEffectiveViewState;
    if (!state || personalOwnerRef.current !== activeView.id) return;
    pendingSearchRef.current = null;
    personalQueueBlockedRef.current = false;
    searchSequenceRef.current += 1;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    confirmedPersonalRef.current = state.personalState;
    personalRevisionRef.current = state.personalState?.editRevision ?? 0;
    setSearchDraft(state.searchText);
    onSearchChange?.(state.searchText);
  }, [activeView.id, effectiveStateQuery, onSearchChange]);

  const persistSearch = useCallback(
    (value: string, sequence: number) => {
      const task = searchPersistQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          // A newer debounced value supersedes queued work before any network
          // mutation starts. In-flight writes remain serialized so every next
          // request uses the revision returned by its predecessor.
          if (
            sequence !== searchSequenceRef.current ||
            personalQueueBlockedRef.current
          )
            return;
          if (personalOwnerRef.current !== activeView.id) return;
          const personal = confirmedPersonalRef.current;
          const response = await executeNonForceableRevisionMutation(
            conflicts,
            upsertPersonalState.trigger,
            {
              databaseId,
              viewId: activeView.id,
              searchText: value,
              sort:
                personal?.sort?.map((rule) => ({
                  direction: rule.direction,
                  fieldId: rule.fieldId,
                })) ?? null,
              filterTree: personal?.filterTree
                ? databaseFilterGroupInputFromOutput(personal.filterTree)
                : null,
              fieldWidthOverrides: personal?.fieldWidthOverrides ?? [],
              collapsedGroupKeys: personal?.collapsedGroupKeys ?? [],
              expectedEditRevision: personalRevisionRef.current,
            },
            {
              attemptedAction: t["Quick search"](),
              localValue: { searchText: value },
              reloadLatest: reloadPersonalState,
            },
          );
          if (!response) {
            personalQueueBlockedRef.current = true;
            return;
          }
          confirmedPersonalRef.current = response.upsertDatabaseViewUserState;
          personalRevisionRef.current =
            response.upsertDatabaseViewUserState.editRevision;
          if (sequence !== searchSequenceRef.current) return;
          pendingSearchRef.current = null;
          setSearchDraft(value);
          onSearchChange?.(value);
          await effectiveStateQuery.mutate();
        })
        .catch((error) => {
          personalQueueBlockedRef.current = true;
          throw error;
        });
      searchPersistQueueRef.current = task;
      return task;
    },
    [
      activeView.id,
      databaseId,
      effectiveStateQuery,
      onSearchChange,
      upsertPersonalState,
      conflicts,
      reloadPersonalState,
      t,
    ],
  );

  const scheduleSearch = useCallback(
    (value: string, immediate = false) => {
      const sequence = ++searchSequenceRef.current;
      pendingSearchRef.current = { value, sequence };
      setSearchDraft(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
      if (immediate) {
        void persistSearch(value, sequence).catch(() =>
          notify.error({ title: t["com.myoxus.common.operation-failed"]() }),
        );
        return;
      }
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        void persistSearch(value, sequence).catch(() =>
          notify.error({ title: t["com.myoxus.common.operation-failed"]() }),
        );
      }, 300);
    },
    [persistSearch, t],
  );

  const flushSearch = useCallback(() => {
    if (!searchTimerRef.current) return;
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    void persistSearch(searchDraft, searchSequenceRef.current).catch(() =>
      notify.error({ title: t["com.myoxus.common.operation-failed"]() }),
    );
  }, [persistSearch, searchDraft, t]);

  const toggleCollapsedGroup = useCallback(
    (groupKey: string, collapsed: boolean) => {
      const task = searchPersistQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (
            personalQueueBlockedRef.current ||
            personalOwnerRef.current !== activeView.id
          )
            return;
          const personal = confirmedPersonalRef.current;
          const keys = personal?.collapsedGroupKeys ?? [];
          if (keys.includes(groupKey) === collapsed) return;
          const response = await executeNonForceableRevisionMutation(
            conflicts,
            upsertPersonalState.trigger,
            {
              databaseId,
              viewId: activeView.id,
              searchText: personal?.searchText ?? effectiveState.searchText,
              sort:
                personal?.sort?.map((rule) => ({
                  fieldId: rule.fieldId,
                  direction: rule.direction,
                })) ?? null,
              filterTree: personal?.filterTree
                ? databaseFilterGroupInputFromOutput(personal.filterTree)
                : null,
              fieldWidthOverrides: personal?.fieldWidthOverrides ?? [],
              collapsedGroupKeys: collapsed
                ? [...keys, groupKey]
                : keys.filter((key) => key !== groupKey),
              expectedEditRevision: personalRevisionRef.current,
            },
            {
              attemptedAction: t["com.myoxus.page.display.grouping"](),
              localValue: { groupKey, collapsed },
              reloadLatest: reloadPersonalState,
            },
          );
          if (!response) {
            personalQueueBlockedRef.current = true;
            return;
          }
          confirmedPersonalRef.current = response.upsertDatabaseViewUserState;
          personalRevisionRef.current =
            response.upsertDatabaseViewUserState.editRevision;
          await effectiveStateQuery.mutate();
        })
        .catch((error) => {
          personalQueueBlockedRef.current = true;
          throw error;
        });
      searchPersistQueueRef.current = task;
      return task;
    },
    [
      activeView.id,
      databaseId,
      effectiveState.searchText,
      effectiveStateQuery,
      upsertPersonalState,
      conflicts,
      reloadPersonalState,
      t,
    ],
  );

  const activeFilterTree = effectiveState.effectiveFilterTree;

  const activeFilterEntries = collectDatabaseFilterRules(activeFilterTree);

  const activeFilterCount = activeFilterEntries.length;

  const activeSort = effectiveState.effectiveSort;

  const hasPersonalQueryChanges = Boolean(
    effectiveState.personalState?.sort ||
    effectiveState.personalState?.filterTree,
  );

  const hasPersonalChanges = Boolean(
    effectiveState.personalState &&
    (effectiveState.searchText ||
      effectiveState.personalState.sort ||
      effectiveState.personalState.filterTree ||
      effectiveState.personalState.fieldWidthOverrides.length ||
      effectiveState.personalState.collapsedGroupKeys.length),
  );

  const openViewControl = useCallback(
    (section: DatabaseViewControlSection, trigger: HTMLElement | null) => {
      viewControlReturnFocusRef.current = trigger;
      setViewEditScope(effectiveState.canEditShared ? "shared" : "personal");
      setViewControlSection(section);
    },
    [effectiveState.canEditShared],
  );

  const copyRowLink = useCallback(
    async (rowId: string) => {
      const copied = await onCopyRowLink?.(rowId, activeView.id);
      if (copied) {
        notify.success({ title: t["Copied link to clipboard"]() });
      } else {
        notify.error({
          title: t["com.myoxus.database.view.copy-link-failed"](),
        });
      }
    },
    [activeView.id, onCopyRowLink, t],
  );

  const changeScheduleZoom = useCallback(
    async (zoom: DatabaseTimelineZoom) => {
      if (
        !effectiveState.canEditShared ||
        ![DatabaseViewKind.Gantt, DatabaseViewKind.Timeline].includes(
          activeView.viewKind,
        ) ||
        (activeView.viewKind === DatabaseViewKind.Timeline
          ? activeView.config.timeline?.zoom
          : activeView.config.gantt?.zoom) === zoom
      )
        return;
      const edits =
        activeView.viewKind === DatabaseViewKind.Timeline
          ? { timelineZoom: zoom }
          : { ganttZoom: zoom };
      const config = createViewConfigInputFromEdits(record, activeView, edits);
      try {
        await executeRevisionMutation(
          conflicts,
          async (variables: UpdateDatabaseViewMutationVariables) => {
            if (!variables.input.force) return triggerUpdateView(variables);
            // A zoom overwrite owns only zoom. Preserve concurrent settings and
            // guard the refreshed config with its real revision on the server.
            const response = await graphqlService.gql({
              query: databaseViewQuery,
              variables: { workspaceId, databaseId, viewId: activeView.id },
            });
            const latest = response.workspace?.databaseView;
            if (!latest || latest.viewKind !== activeView.viewKind)
              throw new Error("Database zoom target changed.");
            return triggerUpdateView({
              input: {
                ...variables.input,
                config: createViewConfigInputFromEdits(record, latest, edits),
                expectedEditRevision: latest.editRevision,
                force: false,
              },
            });
          },
          {
            databaseId,
            viewId: activeView.id,
            config,
            expectedEditRevision: activeView.editRevision,
          },
          {
            attemptedAction: t["com.myoxus.database.schedule.zoom"](),
            localValue: databaseTimelineZoomLabel(t, zoom),
            reloadLatest: onChanged,
            afterSuccess: () =>
              onChanged({
                kind: "view_updated",
                target: { viewId: activeView.id },
              }),
            afterForceSuccess: () =>
              onChanged({
                kind: "view_updated",
                target: { viewId: activeView.id },
              }),
          },
        );
      } catch {
        notify.error({
          title: t["com.myoxus.database.schedule.zoom"](),
          message: t["com.myoxus.database.view.update-failed"](),
          actions: [
            {
              label: t["com.myoxus.database.conflict.reload"](),
              onClick: () => onChanged(),
            },
          ],
        });
      }
    },
    [
      activeView,
      conflicts,
      databaseId,
      graphqlService,
      workspaceId,
      effectiveState.canEditShared,
      onChanged,
      record,
      t,
      triggerUpdateView,
    ],
  );

  const rowDetailContext = useMemo<DatabaseRowDetailContextValue>(
    () => ({
      canEdit: effectiveState.canEditRows,
      ...(onCopyRowLink
        ? {
            copyLink: (row) => {
              void copyRowLink(row.row.id);
            },
          }
        : {}),
      openById: (rowId, trigger) => {
        taskNavigation.requestLeave?.(() => {
          resetTaskNavigation();
          detailReturnFocusRef.current = trigger ?? null;
          setDetailRowId(rowId);
          onRowDetailChange?.(rowId);
        });
      },
      open: (row, trigger) => {
        taskNavigation.requestLeave?.(() => {
          resetTaskNavigation();
          detailReturnFocusRef.current = trigger ?? null;
          setDetailRowId(row.row.id);
          onRowDetailChange?.(row.row.id);
        });
      },
    }),
    [
      copyRowLink,
      effectiveState.canEditRows,
      onCopyRowLink,
      onRowDetailChange,
      resetTaskNavigation,
      taskNavigation.requestLeave,
    ],
  );

  const closeRowDetail = useCallback(() => {
    taskNavigation.requestLeave?.(() => {
      // Switching views unmounts the original row trigger. Restore focus to
      // the visible view control instead of a detached or hidden row button.
      if (!detailReturnFocusRef.current?.isConnected) {
        detailReturnFocusRef.current = detailFallbackFocusRef.current;
      }
      setDetailRowId(null);
      onRowDetailChange?.(null);
    });
  }, [onRowDetailChange, taskNavigation.requestLeave]);

  const registerPrimaryAction = useCallback(
    (action: DatabaseViewPrimaryAction | null) => {
      primaryActionHandlerRef.current = action?.onSelect ?? null;
      setPrimaryAction((current) => {
        if (!action) return null;
        if (
          current?.label === action.label &&
          current.disabled === action.disabled &&
          current.disabledReason === action.disabledReason
        ) {
          return current;
        }
        return {
          disabled: action.disabled,
          disabledReason: action.disabledReason,
          label: action.label,
          onSelect: () => primaryActionHandlerRef.current?.(),
        };
      });
    },
    [],
  );

  const currentDetailRowId = useRef(detailRowId);
  currentDetailRowId.current = detailRowId;
  const latestInitialRowId = useRef(initialRowId);
  latestInitialRowId.current = initialRowId;
  useEffect(() => {
    if (initialRowId === currentDetailRowId.current) return;
    // Non-route hosts may change their selection prop without pane history.
    taskNavigation.requestLeave?.(() => {
      setDetailRowId(latestInitialRowId.current);
    });
  }, [initialRowId, taskNavigation.requestLeave]);

  useEffect(() => {
    if (
      activeView.viewKind !== DatabaseViewKind.Kanban &&
      activeView.viewKind !== DatabaseViewKind.Progress &&
      activeView.viewKind !== DatabaseViewKind.Gantt &&
      activeView.viewKind !== DatabaseViewKind.Timeline
    ) {
      registerPrimaryAction(null);
    }
  }, [activeView.id, activeView.viewKind, registerPrimaryAction]);

  const addTableView = useCallback(async () => {
    const response = await createView.trigger({
      input: {
        databaseId,
        name: proposeDatabaseViewName(
          record,
          t["com.myoxus.database.view.table"](),
        ),
        viewKind: DatabaseViewKind.Table,
        config: createTableViewConfigInput(record),
      },
    });
    if (!response) return;
    const viewId = response.createDatabaseView.id;
    onActiveViewChange(viewId);
    await onChanged({ kind: "view_created", target: { viewId } });
  }, [createView, databaseId, onActiveViewChange, onChanged, record, t]);

  const addKanbanView = useCallback(() => {
    notify.warning({
      title: t["com.myoxus.database.kanban.invalid-title"](),
      message: t["com.myoxus.database.kanban.invalid-description"](),
    });
    setKanbanSetupTarget({ kind: "create" });
  }, [t]);

  const addListView = useCallback(async () => {
    const response = await createView.trigger({
      input: {
        databaseId,
        name: proposeDatabaseViewName(
          record,
          t["com.myoxus.database.view.list"](),
        ),
        viewKind: DatabaseViewKind.List,
        config: createListViewConfigInput(record),
      },
    });
    if (!response) return;
    const viewId = response.createDatabaseView.id;
    onActiveViewChange(viewId);
    await onChanged({ kind: "view_created", target: { viewId } });
  }, [createView, databaseId, onActiveViewChange, onChanged, record, t]);

  const addGalleryView = useCallback(async () => {
    const response = await createView.trigger({
      input: {
        databaseId,
        name: proposeDatabaseViewName(
          record,
          t["com.myoxus.database.view.gallery"](),
        ),
        viewKind: DatabaseViewKind.Gallery,
        config: createGalleryViewConfigInput(record),
      },
    });
    if (!response) return;
    const viewId = response.createDatabaseView.id;
    onActiveViewChange(viewId);
    await onChanged({ kind: "view_created", target: { viewId } });
  }, [createView, databaseId, onActiveViewChange, onChanged, record, t]);

  const addCalendarView = useCallback(async () => {
    const dateField = getFirstDatabaseDateField(record);
    if (!dateField) {
      notify.error({
        title: t["com.myoxus.database.calendar.needs-date"](),
      });
      return;
    }
    const response = await createView.trigger({
      input: {
        databaseId,
        name: proposeDatabaseViewName(
          record,
          t["com.myoxus.database.view.calendar"](),
        ),
        viewKind: DatabaseViewKind.Calendar,
        config: createCalendarViewConfigInput(record, dateField.id),
      },
    });
    if (!response) return;
    const viewId = response.createDatabaseView.id;
    onActiveViewChange(viewId);
    await onChanged({ kind: "view_created", target: { viewId } });
  }, [createView, databaseId, onActiveViewChange, onChanged, record, t]);

  const addGanttView = useCallback(async () => {
    const dateField = getFirstDatabaseDateField(record);
    if (!dateField) {
      notify.error({
        title: t["com.myoxus.database.gantt.needs-date"](),
      });
      return;
    }
    const response = await createView.trigger({
      input: {
        databaseId,
        name: proposeDatabaseViewName(
          record,
          t["com.myoxus.database.view.gantt"](),
        ),
        viewKind: DatabaseViewKind.Gantt,
        config: createGanttViewConfigInput(record, dateField.id),
      },
    });
    if (!response) return;
    const viewId = response.createDatabaseView.id;
    onActiveViewChange(viewId);
    await onChanged({ kind: "view_created", target: { viewId } });
  }, [createView, databaseId, onActiveViewChange, onChanged, record, t]);

  const timelineCreatePendingRef = useRef(false);
  const addTimelineView = useCallback(async () => {
    if (timelineCreatePendingRef.current) return;
    const dateField = getFirstDatabaseDateField(record);
    if (!dateField) {
      notify.error({
        title: t["com.myoxus.database.timeline.needs-date"](),
      });
      return;
    }
    timelineCreatePendingRef.current = true;
    try {
      const response = await createView.trigger({
        input: {
          databaseId,
          name: proposeDatabaseViewName(
            record,
            t["com.myoxus.database.view.timeline"](),
          ),
          viewKind: DatabaseViewKind.Timeline,
          config: createTimelineViewConfigInput(record, dateField.id),
        },
      });
      if (!response) return;
      const viewId = response.createDatabaseView.id;
      onActiveViewChange(viewId);
      await onChanged({ kind: "view_created", target: { viewId } });
    } finally {
      timelineCreatePendingRef.current = false;
    }
  }, [createView, databaseId, onActiveViewChange, onChanged, record, t]);

  const addProgressView = useCallback(() => {
    setProgressSetupOpen(true);
  }, []);

  const copyViewLink = useCallback(
    async (viewId: string) => {
      const copied = await onCopyViewLink?.(viewId);
      if (copied) {
        notify.success({ title: t["Copied link to clipboard"]() });
      } else {
        notify.error({
          title: t["com.myoxus.database.view.copy-link-failed"](),
        });
      }
    },
    [onCopyViewLink, t],
  );

  const renameView = useCallback(
    async (view: (typeof record.views)[number], name: string) => {
      if (name === view.name) return true;
      try {
        await executeRevisionMutation(
          conflicts,
          triggerUpdateView,
          {
            databaseId,
            viewId: view.id,
            name,
            expectedEditRevision: view.editRevision,
          },
          {
            attemptedAction: t["Rename"](),
            localValue: name,
            reloadLatest: () => onChanged(),
            afterSuccess: () =>
              onChanged({ kind: "view_updated", target: { viewId: view.id } }),
          },
        );
        return true;
      } catch {
        notify.error({
          title: t["com.myoxus.database.view.update-failed"](),
        });
        return false;
      }
    },
    [conflicts, databaseId, onChanged, t, triggerUpdateView],
  );

  const deleteDatabaseView = useCallback(
    async (view: (typeof record.views)[number]) => {
      if (record.views.length <= 1) return;
      try {
        await executeRevisionMutation(
          conflicts,
          deleteView.trigger,
          {
            databaseId,
            viewId: view.id,
            expectedEditRevision: view.editRevision,
          },
          {
            attemptedAction: t["com.myoxus.database.view.delete"](),
            localValue: view.name,
            reloadLatest: () => onChanged(),
            afterSuccess: async () => {
              if (view.id === activeView.id) {
                onActiveViewChange(
                  sortByPosition(record.views).find(
                    (candidate) => candidate.id !== view.id,
                  )?.id ?? null,
                );
              }
              await onChanged({
                kind: "view_deleted",
                target: { viewId: view.id },
              });
            },
          },
        );
      } catch {
        notify.error({
          title: t["com.myoxus.database.view.update-failed"](),
        });
      }
    },
    [
      activeView.id,
      conflicts,
      databaseId,
      deleteView,
      onActiveViewChange,
      onChanged,
      record.views,
      t,
    ],
  );

  const reorderDatabaseViews = useCallback(
    async (orderedViewIds: string[]) => {
      const authoritativeIds = sortByPosition(record.views).map(
        (view) => view.id,
      );
      if (
        orderedViewIds.length !== authoritativeIds.length ||
        orderedViewIds.some((viewId) => !authoritativeIds.includes(viewId))
      ) {
        return;
      }
      setOptimisticViewOrder(orderedViewIds);
      const reloadLatest = async () => {
        setOptimisticViewOrder(null);
        await onChanged();
      };
      try {
        const response = await executeRevisionMutation(
          conflicts,
          reorderViews.trigger,
          {
            databaseId,
            viewIds: orderedViewIds,
            expectedEditRevisions: record.views.map((view) => ({
              viewId: view.id,
              expectedEditRevision: view.editRevision,
            })),
          },
          {
            attemptedAction: t["com.myoxus.database.view.reorder"](),
            localValue: orderedViewIds,
            reloadLatest,
            afterSuccess: async (result) => {
              const authoritativeViews = result?.reorderDatabaseViews;
              if (authoritativeViews) {
                setOptimisticViewOrder(
                  authoritativeViews.map((view) => view.id),
                );
              }
              await onChanged({ kind: "view_reordered" });
              setOptimisticViewOrder(null);
            },
          },
        );
        if (!response) setOptimisticViewOrder(null);
      } catch {
        await reloadLatest();
        notify.error({
          title: t["com.myoxus.database.view.reorder-failed"](),
        });
      }
    },
    [conflicts, databaseId, onChanged, record.views, reorderViews, t],
  );

  const reloadEffectiveView = useCallback(async () => {
    await onChanged();
    await effectiveStateQuery.mutate();
  }, [effectiveStateQuery, onChanged]);
  const refreshEffectiveView = useCallback(async () => {
    await onChanged({
      kind: "view_updated",
      target: { viewId: activeView.id },
    });
    await effectiveStateQuery.mutate();
  }, [activeView.id, effectiveStateQuery, onChanged]);

  // This scope branch is the write boundary: personal edits mutate only the
  // user's View state; shared edits use the revision-checked View contract.
  const persistFilterTree = useCallback(
    async (nextFilterTree: DatabaseFilterGroupInput | null) => {
      if (viewEditScope === "personal") {
        const personal = effectiveState.personalState;
        const response = await upsertPersonalState.trigger({
          input: {
            databaseId,
            viewId: activeView.id,
            searchText: effectiveState.searchText,
            sort:
              personal?.sort?.map((rule) => ({
                direction: rule.direction,
                fieldId: rule.fieldId,
              })) ?? null,
            // An empty root is the explicit personal "no filters" override;
            // null means inherit the shared saved filters.
            filterTree: nextFilterTree ?? createDatabaseFilterGroup(),
            fieldWidthOverrides: personal?.fieldWidthOverrides ?? [],
            collapsedGroupKeys: personal?.collapsedGroupKeys ?? [],
            expectedEditRevision: personalRevisionRef.current,
          },
        });
        personalRevisionRef.current =
          response.upsertDatabaseViewUserState.editRevision;
        await effectiveStateQuery.mutate();
        await onChanged({ kind: "view_result_updated" });
        return;
      }
      const config = createViewConfigInputFromEdits(record, activeView, {
        filter: [],
        filterTree: nextFilterTree,
      });
      await executeRevisionMutation(
        conflicts,
        triggerUpdateView,
        {
          databaseId,
          viewId: activeView.id,
          config,
          name: activeView.name,
          expectedEditRevision: activeView.editRevision,
        },
        {
          attemptedAction: t["com.myoxus.database.view.clear-filters"](),
          localValue: config,
          reloadLatest: reloadEffectiveView,
          afterSuccess: refreshEffectiveView,
        },
      );
    },
    [
      activeView,
      conflicts,
      databaseId,
      effectiveState,
      effectiveStateQuery,
      onChanged,
      record,
      reloadEffectiveView,
      refreshEffectiveView,
      t,
      triggerUpdateView,
      upsertPersonalState,
      viewEditScope,
    ],
  );

  const persistSort = useCallback(
    async (nextSort: DatabaseSortRuleInput[]) => {
      if (viewEditScope === "personal") {
        const personal = effectiveState.personalState;
        const response = await upsertPersonalState.trigger({
          input: {
            databaseId,
            viewId: activeView.id,
            searchText: effectiveState.searchText,
            sort: nextSort,
            filterTree: personal?.filterTree
              ? databaseFilterGroupInputFromOutput(personal.filterTree)
              : null,
            fieldWidthOverrides: personal?.fieldWidthOverrides ?? [],
            collapsedGroupKeys: personal?.collapsedGroupKeys ?? [],
            expectedEditRevision: personalRevisionRef.current,
          },
        });
        personalRevisionRef.current =
          response.upsertDatabaseViewUserState.editRevision;
        await effectiveStateQuery.mutate();
        await onChanged({ kind: "view_result_updated" });
        return;
      }
      const config = createViewConfigInputFromEdits(record, activeView, {
        sort: nextSort,
      });
      await executeRevisionMutation(
        conflicts,
        triggerUpdateView,
        {
          databaseId,
          viewId: activeView.id,
          config,
          name: activeView.name,
          expectedEditRevision: activeView.editRevision,
        },
        {
          attemptedAction: t["com.myoxus.database.view.sort-field"](),
          localValue: config,
          reloadLatest: reloadEffectiveView,
          afterSuccess: refreshEffectiveView,
        },
      );
    },
    [
      activeView,
      conflicts,
      databaseId,
      effectiveState,
      effectiveStateQuery,
      onChanged,
      record,
      reloadEffectiveView,
      refreshEffectiveView,
      t,
      triggerUpdateView,
      upsertPersonalState,
      viewEditScope,
    ],
  );

  const updateEffectivePrimarySort = useCallback(
    (field: DatabaseField, descending: boolean | null) => {
      const remaining = activeSort
        .filter((rule) => rule.fieldId !== field.id)
        .map((rule) => ({
          fieldId: rule.fieldId,
          direction: rule.direction,
        }));
      const nextSort =
        descending === null
          ? remaining
          : [
              {
                fieldId: field.id,
                direction: descending
                  ? DatabaseSortDirection.Desc
                  : DatabaseSortDirection.Asc,
              },
              ...remaining,
            ];
      return persistSort(nextSort);
    },
    [activeSort, persistSort],
  );

  const applyProgressGroupFilter = useCallback(
    (field: DatabaseField, key: string) => {
      const rule = databaseProgressGroupFilterRule(field, key);
      if (!rule) return Promise.resolve();
      const current = activeFilterTree
        ? databaseFilterGroupInputFromOutput(activeFilterTree)
        : null;
      return persistFilterTree(applyDatabaseProgressGroupFilter(current, rule));
    },
    [activeFilterTree, persistFilterTree],
  );

  const clearFilters = useCallback(
    () => persistFilterTree(null),
    [persistFilterTree],
  );

  const removeActiveFilter = useCallback(
    (groupPath: number[], ruleIndex: number) => {
      if (!activeFilterTree) return Promise.resolve();
      const next = removeDatabaseFilterRule(
        databaseFilterGroupInputFromOutput(activeFilterTree),
        groupPath,
        ruleIndex,
      );
      const hasFilters =
        (next.rules?.length ?? 0) > 0 || (next.groups?.length ?? 0) > 0;
      return persistFilterTree(hasFilters ? next : null);
    },
    [activeFilterTree, persistFilterTree],
  );

  const resetForMe = useCallback(async () => {
    const personal = effectiveState.personalState;
    if (!personal) return;
    await resetPersonalState.trigger({
      input: {
        databaseId,
        viewId: activeView.id,
        expectedEditRevision: personalRevisionRef.current,
      },
    });
    confirmedPersonalRef.current = null;
    personalRevisionRef.current = 0;
    setSearchDraft("");
    onSearchChange?.("");
    await effectiveStateQuery.mutate();
    await onChanged({ kind: "view_result_updated" });
  }, [
    activeView.id,
    databaseId,
    effectiveState.personalState,
    effectiveStateQuery,
    onChanged,
    onSearchChange,
    resetPersonalState,
  ]);

  const saveForView = useCallback(async () => {
    await savePersonalState.trigger({
      input: {
        databaseId,
        viewId: activeView.id,
        expectedViewEditRevision: activeView.editRevision,
      },
    });
    await effectiveStateQuery.mutate();
    await onChanged({
      kind: "view_updated",
      target: { viewId: activeView.id },
    });
  }, [
    activeView.editRevision,
    activeView.id,
    databaseId,
    effectiveStateQuery,
    onChanged,
    savePersonalState,
  ]);
  return {
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
    conflicts,
    copyViewLink,
    deleteDatabaseView,
    deleteProgressRow,
    deleteView,
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
  };
}
