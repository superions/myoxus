// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import { GraphQLService } from "@myoxus/core/modules/server";
import { TagService } from "@myoxus/core/modules/tag/service/tag";
import {
  DatabaseCalendarDateMode,
  DatabaseCalendarInitialRange,
  DatabaseCardDensity,
  DatabaseFieldKind,
  type DatabaseFieldWidthInput,
  type DatabaseFilterGroupInput,
  DatabaseGalleryCardDensity,
  DatabaseListDensity,
  DatabaseRelativeDatePreset,
  DatabaseSortDirection,
  type DatabaseSortRuleInput,
  DatabaseTimelineGroupBy,
  DatabaseTimelineOrder,
  DatabaseTimelineZoom,
  DatabaseViewKind,
  DatabaseViewSystemIcon,
  databaseViewQuery,
  type UpdateDatabaseViewMutationVariables,
  updateDatabaseViewMutation,
  upsertDatabaseViewUserStateMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  CloseIcon,
  PlusIcon,
  TrashIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Button,
  Divider,
  FormFieldset,
  FormRow,
  Group,
  IconButton,
  Input,
  Modal,
  MultiSelect,
  MyoxusSegmentedControl,
  MyoxusText,
  notify,
  NumberInput,
  Select,
  Stack,
  Switch,
} from "@myoxus/ui-facade";
import {
  type RefObject,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createViewConfigInputForKind,
  createViewConfigInputFromEdits,
  databaseFieldSupportsSavedSort,
  databaseFieldSupportsSearch,
  databaseFilterGroupInputFromOutput,
  databaseViewKindIsAvailable,
  getFieldById,
  getViewGroupRules,
  getVisibleFieldIds,
  isDatabaseDateSourceField,
  isDatabaseProjectionField,
  sortByPosition,
} from "../model";
import { useDatabaseConflictController } from "../presence";
import { executeRevisionMutation } from "../presence/execute-revision-mutation";
import type { DatabaseChangeHandler } from "../shared";
import type { DatabaseRecord, DatabaseView } from "../types";
import type {
  DatabaseEffectiveViewState,
  DatabaseViewControlSection,
  DatabaseViewEditScope,
} from "./filter-tree";
import {
  createDatabaseFilterGroup,
  DatabaseFilterGroupEditor,
  moveDatabaseFilterItem,
} from "./filter-tree";
import {
  databaseCalendarDateModeLabel,
  databaseDensityLabel,
  databaseFieldSupportsGrouping,
  databaseFieldSupportsProgressGrouping,
  databaseFilterRuleIsComplete,
  databaseRelativeDatePresetLabel,
  databaseTimelineGroupLabel,
  databaseTimelineZoomLabel,
  databaseViewControlTitle,
  databaseViewKindLabel,
  databaseViewSystemIconLabel,
  VIEW_SORT_NONE,
} from "./labels";

export type DatabaseViewSettingsSaveStatus =
  "idle" | "dirty" | "saving" | "saved" | "conflict" | "failure";

export function ViewSettingsSectionEditor({
  active = true,
  databaseId,
  effectiveState,
  editScope,
  onChanged,
  onEditScopeChange,
  onEffectiveStateChanged,
  onSaved,
  record,
  section,
  showCancel = false,
  onCancel,
  view,
}: {
  active?: boolean;
  databaseId: string;
  effectiveState: DatabaseEffectiveViewState;
  editScope: DatabaseViewEditScope;
  onChanged: DatabaseChangeHandler;
  onEditScopeChange: (scope: DatabaseViewEditScope) => void;
  onEffectiveStateChanged: () => Promise<void>;
  onSaved?: () => void;
  record: DatabaseRecord;
  section: DatabaseViewControlSection;
  showCancel?: boolean;
  onCancel?: () => void;
  view: DatabaseView;
}) {
  const t = useI18n();
  const conflicts = useDatabaseConflictController();
  const graphqlService = useService(GraphQLService);
  const updateView = useMutation({
    mutation: updateDatabaseViewMutation,
  });
  const upsertPersonalState = useMutation({
    mutation: upsertDatabaseViewUserStateMutation,
  });
  const tagService = useService(TagService);
  const workspaceTags = useLiveData(tagService.tagList.tagMetas$);
  const fieldOptions = useMemo(
    () =>
      sortByPosition(record.fields).map((field) => ({
        value: field.id,
        label: field.name,
      })),
    [record.fields],
  );
  const sortFieldOptions = useMemo(
    () =>
      sortByPosition(record.fields)
        .filter(databaseFieldSupportsSavedSort)
        .map((field) => ({ value: field.id, label: field.name })),
    [record.fields],
  );
  const groupFieldOptions = useMemo(
    () =>
      sortByPosition(record.fields)
        .filter(
          view.viewKind === DatabaseViewKind.Progress
            ? databaseFieldSupportsProgressGrouping
            : databaseFieldSupportsGrouping,
        )
        .map((field) => ({ value: field.id, label: field.name })),
    [record.fields, view.viewKind],
  );
  const progressFieldOptions = useMemo(
    () =>
      sortByPosition(record.fields)
        .filter((field) => field.fieldType === DatabaseFieldKind.Percent)
        .map((field) => ({ value: field.id, label: field.name })),
    [record.fields],
  );
  const tagOptions = useMemo(
    () =>
      workspaceTags
        .filter((tag) => !tag.archived)
        .map((tag) => ({ value: tag.id, label: tag.name })),
    [workspaceTags],
  );
  const selectFieldOptions = useMemo(
    () =>
      sortByPosition(record.fields)
        .filter(
          (field) =>
            field.fieldType === DatabaseFieldKind.Status ||
            field.fieldType === DatabaseFieldKind.Select,
        )
        .sort((left, right) => {
          if (left.fieldType === right.fieldType)
            return left.position - right.position;
          return left.fieldType === DatabaseFieldKind.Status ? -1 : 1;
        })
        .map((field) => ({
          value: field.id,
          label: field.name,
        })),
    [record.fields],
  );
  const [visibleFieldIds, setVisibleFieldIds] = useState<string[]>([]);
  const [fieldWidths, setFieldWidths] = useState<DatabaseFieldWidthInput[]>([]);
  const [iconMode, setIconMode] = useState<"default" | "emoji" | "system">(
    "default",
  );
  const [iconEmoji, setIconEmoji] = useState("");
  const [iconSystem, setIconSystem] = useState<DatabaseViewSystemIcon>(
    DatabaseViewSystemIcon.Table,
  );
  const [viewKind, setViewKind] = useState(view.viewKind);
  const [saveStatus, setSaveStatus] =
    useState<DatabaseViewSettingsSaveStatus>("idle");
  const draftDirtyRef = useRef(false);
  const savePendingRef = useRef(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const draftOwnerRef = useRef<string | null>(null);
  const wasActiveRef = useRef(false);
  const draftViewRevisionRef = useRef(view.editRevision);
  const [filterTree, setFilterTree] = useState<DatabaseFilterGroupInput>(
    createDatabaseFilterGroup,
  );
  const [sortRules, setSortRules] = useState<DatabaseSortRuleInput[]>([]);
  const [groupFieldId, setGroupFieldId] = useState<string | null>(null);
  const [groupDescending, setGroupDescending] = useState(false);
  const [showEmptyGroups, setShowEmptyGroups] = useState(true);
  const [progressFieldId, setProgressFieldId] = useState<string | null>(null);
  const [subgroupFieldId, setSubgroupFieldId] = useState<string | null>(null);
  const [subgroupDescending, setSubgroupDescending] = useState(false);
  const [showEmptySubgroups, setShowEmptySubgroups] = useState(true);
  const [searchFieldIds, setSearchFieldIds] = useState<string[]>([]);
  const [coverFieldId, setCoverFieldId] = useState<string | null>(null);
  const [cardDensity, setCardDensity] = useState<DatabaseCardDensity>(
    DatabaseCardDensity.Default,
  );
  const [galleryCardDensity, setGalleryCardDensity] =
    useState<DatabaseGalleryCardDensity>(DatabaseGalleryCardDensity.Default);
  const [listDensity, setListDensity] = useState<DatabaseListDensity>(
    DatabaseListDensity.Default,
  );
  const [showFieldLabels, setShowFieldLabels] = useState(true);
  const [showEmptyCover, setShowEmptyCover] = useState(true);
  const [calendarDateFieldId, setCalendarDateFieldId] = useState("");
  const [calendarDateMode, setCalendarDateMode] =
    useState<DatabaseCalendarDateMode>(DatabaseCalendarDateMode.Month);
  const [calendarInitialRange, setCalendarInitialRange] =
    useState<DatabaseCalendarInitialRange>(
      DatabaseCalendarInitialRange.CurrentMonth,
    );
  const [timelineStartFieldId, setTimelineStartFieldId] = useState("");
  const [timelineEndFieldId, setTimelineEndFieldId] = useState<string | null>(
    null,
  );
  const [timelineZoom, setTimelineZoom] = useState<DatabaseTimelineZoom>(
    DatabaseTimelineZoom.Month,
  );
  const [timelineGroupBy, setTimelineGroupBy] =
    useState<DatabaseTimelineGroupBy>(DatabaseTimelineGroupBy.Month);
  const [timelineOrder, setTimelineOrder] = useState<DatabaseTimelineOrder>(
    DatabaseTimelineOrder.Asc,
  );
  const [ganttDependencyFieldId, setGanttDependencyFieldId] = useState<
    string | null
  >(null);
  const supportsGroupRules = [
    DatabaseViewKind.Calendar,
    DatabaseViewKind.Gallery,
    DatabaseViewKind.Gantt,
    DatabaseViewKind.List,
    DatabaseViewKind.Progress,
    DatabaseViewKind.Table,
  ].includes(view.viewKind);
  const draftOwner = `${databaseId}:${view.id}:${section}:${editScope}`;

  useEffect(() => {
    const becameActive = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active) return;
    const ownerChanged = draftOwnerRef.current !== draftOwner;
    // A background effective-state refresh must not erase an in-progress form.
    // Reopening the section or changing its View/scope still starts fresh.
    if (!becameActive && !ownerChanged && draftDirtyRef.current) {
      return;
    }
    draftOwnerRef.current = draftOwner;
    draftDirtyRef.current = false;
    draftViewRevisionRef.current = view.editRevision;
    const groups = getViewGroupRules(view);
    setViewKind(view.viewKind);
    setVisibleFieldIds(getVisibleFieldIds(record, view));
    setFieldWidths(view.config.table?.fieldWidths ?? []);
    setIconMode(
      view.icon?.emoji ? "emoji" : view.icon?.system ? "system" : "default",
    );
    setIconEmoji(view.icon?.emoji ?? "");
    setIconSystem(view.icon?.system ?? DatabaseViewSystemIcon.Table);
    const selectedTree =
      editScope === "personal"
        ? effectiveState.effectiveFilterTree
        : effectiveState.savedFilterTree;
    setFilterTree(
      selectedTree
        ? databaseFilterGroupInputFromOutput(selectedTree)
        : createDatabaseFilterGroup(),
    );
    setSortRules(
      (editScope === "personal"
        ? effectiveState.effectiveSort
        : effectiveState.savedSort
      ).map((rule) => ({
        fieldId: rule.fieldId,
        direction: rule.direction,
      })),
    );
    setGroupFieldId(
      view.config.kanban?.groupFieldId ??
        view.config.progress?.groupFieldId ??
        groups.group?.fieldId ??
        null,
    );
    setProgressFieldId(view.config.progress?.progressFieldId ?? null);
    setSubgroupFieldId(groups.subgroup?.fieldId ?? null);
    setGroupDescending(groups.group?.descending ?? false);
    setShowEmptyGroups(groups.group?.showEmptyGroups ?? true);
    setSubgroupDescending(groups.subgroup?.descending ?? false);
    setShowEmptySubgroups(groups.subgroup?.showEmptyGroups ?? true);
    setSearchFieldIds(view.config.table?.searchFieldIds ?? []);
    setCoverFieldId(
      view.config.kanban?.coverFieldId ??
        view.config.gallery?.coverFieldId ??
        null,
    );
    setCardDensity(
      view.config.kanban?.cardDensity ?? DatabaseCardDensity.Default,
    );
    setGalleryCardDensity(
      view.config.gallery?.cardDensity ?? DatabaseGalleryCardDensity.Default,
    );
    setListDensity(view.config.list?.density ?? DatabaseListDensity.Default);
    setShowFieldLabels(view.config.list?.showFieldLabels ?? true);
    setShowEmptyCover(view.config.gallery?.showEmptyCover ?? true);
    setCalendarDateFieldId(view.config.calendar?.dateFieldId ?? "");
    setCalendarDateMode(
      view.config.calendar?.dateMode ?? DatabaseCalendarDateMode.Month,
    );
    setCalendarInitialRange(
      view.config.calendar?.initialRange ??
        DatabaseCalendarInitialRange.CurrentMonth,
    );
    setTimelineStartFieldId(
      view.config.gantt?.startFieldId ??
        view.config.timeline?.startFieldId ??
        "",
    );
    setTimelineEndFieldId(
      view.config.gantt?.endFieldId ?? view.config.timeline?.endFieldId ?? null,
    );
    setTimelineZoom(
      view.config.gantt?.zoom ??
        view.config.timeline?.zoom ??
        DatabaseTimelineZoom.Month,
    );
    setTimelineGroupBy(
      view.config.timeline?.groupBy ?? DatabaseTimelineGroupBy.Month,
    );
    setTimelineOrder(view.config.timeline?.order ?? DatabaseTimelineOrder.Asc);
    setGanttDependencyFieldId(view.config.gantt?.dependencyFieldId ?? null);
    setSaveStatus("idle");
  }, [
    active,
    draftOwner,
    editScope,
    effectiveState,
    record,
    view,
    reloadRevision,
  ]);

  const markDirty = useCallback(() => {
    if (savePendingRef.current) return;
    draftDirtyRef.current = true;
    setSaveStatus((status) => (status === "saving" ? status : "dirty"));
  }, []);

  // Portaled Mantine selections update controlled values without a native
  // change event on the fieldset. Capture the draft before a remote refresh.
  const updateDraft = useCallback(
    <T,>(
      setValue: Dispatch<SetStateAction<T>>,
      value: NoInfer<SetStateAction<T>>,
    ) => {
      if (savePendingRef.current) return;
      markDirty();
      setValue(value);
    },
    [markDirty],
  );

  const personalQueryEdit =
    editScope === "personal" && (section === "filter" || section === "sort");
  const canWrite = personalQueryEdit || effectiveState.canEditShared;

  const save = useCallback(async () => {
    if (!canWrite || savePendingRef.current) return;
    if (
      viewKind === view.viewKind &&
      view.viewKind === DatabaseViewKind.Kanban &&
      !groupFieldId
    ) {
      notify.error({
        title: t["com.myoxus.database.kanban.needs-select"](),
      });
      return;
    }
    if (
      viewKind === view.viewKind &&
      view.viewKind === DatabaseViewKind.Progress &&
      !progressFieldId
    ) {
      notify.error({
        title: t["com.myoxus.database.progress.needs-percent"](),
      });
      return;
    }
    if (section === "advanced" && iconMode === "emoji" && !iconEmoji.trim()) {
      return;
    }
    const filterTreeIsComplete = (group: DatabaseFilterGroupInput): boolean =>
      (group.rules ?? []).every(databaseFilterRuleIsComplete) &&
      (group.groups ?? []).every(filterTreeIsComplete);
    if (section === "filter" && !filterTreeIsComplete(filterTree)) return;
    savePendingRef.current = true;
    setSaveStatus("saving");
    try {
      if (personalQueryEdit) {
        const personal = effectiveState.personalState;
        await upsertPersonalState.trigger({
          input: {
            databaseId,
            viewId: view.id,
            searchText: effectiveState.searchText,
            sort:
              section === "sort"
                ? sortRules
                : (personal?.sort?.map((rule) => ({
                    direction: rule.direction,
                    fieldId: rule.fieldId,
                  })) ?? null),
            filterTree:
              section === "filter"
                ? filterTree
                : personal?.filterTree
                  ? databaseFilterGroupInputFromOutput(personal.filterTree)
                  : null,
            fieldWidthOverrides: personal?.fieldWidthOverrides ?? [],
            collapsedGroupKeys: personal?.collapsedGroupKeys ?? [],
            expectedEditRevision: personal?.editRevision ?? 0,
          },
        });
        await onEffectiveStateChanged();
        await onChanged({ kind: "view_result_updated" });
        draftDirtyRef.current = false;
        setSaveStatus("saved");
        onSaved?.();
        return;
      }
      const group =
        supportsGroupRules && groupFieldId
          ? {
              descending: groupDescending,
              fieldId: groupFieldId,
              showEmptyGroups,
            }
          : null;
      const subgroup =
        group && subgroupFieldId
          ? {
              descending: subgroupDescending,
              fieldId: subgroupFieldId,
              showEmptyGroups: showEmptySubgroups,
            }
          : null;
      const buildConfig = (baseView: DatabaseView) => {
        if (section === "advanced" && viewKind !== view.viewKind) {
          return createViewConfigInputForKind(record, baseView, viewKind, {
            visibleFieldIds,
          });
        }

        // Each settings section owns only its displayed controls. Preserving
        // every other value from the latest View prevents a filter save from
        // replaying stale sort/layout drafts held by the same mounted modal.
        switch (section) {
          case "filter":
            return createViewConfigInputFromEdits(record, baseView, {
              filter: [],
              filterTree:
                (filterTree.rules?.length ?? 0) > 0 ||
                (filterTree.groups?.length ?? 0) > 0
                  ? filterTree
                  : null,
            });
          case "sort":
            return createViewConfigInputFromEdits(record, baseView, {
              sort: sortRules,
            });
          case "group":
            return createViewConfigInputFromEdits(record, baseView, {
              ganttGroup:
                view.viewKind === DatabaseViewKind.Gantt ? group : undefined,
              group,
              groupFieldId: groupFieldId ?? undefined,
              subgroup,
            });
          case "display":
            return createViewConfigInputFromEdits(record, baseView, {
              calendarDateMode,
              calendarInitialRange,
              cardDensity,
              coverFieldId,
              fieldWidths,
              galleryCardDensity,
              galleryShowEmptyCover: showEmptyCover,
              ganttZoom: timelineZoom,
              listDensity,
              listShowFieldLabels: showFieldLabels,
              searchFieldIds,
              timelineGroupBy,
              timelineOrder,
              timelineZoom,
            });
          case "fields":
            return createViewConfigInputFromEdits(record, baseView, {
              calendarDateFieldId,
              ganttDependencyFieldId,
              ganttEndFieldId: timelineEndFieldId,
              ganttStartFieldId: timelineStartFieldId,
              progressFieldId: progressFieldId ?? undefined,
              timelineEndFieldId,
              timelineStartFieldId,
              visibleFieldIds,
            });
          case "advanced":
            return createViewConfigInputFromEdits(record, baseView, {});
        }
      };
      const config = buildConfig(view);
      const fieldName = (id: string | null | undefined) =>
        record.fields.find((field) => field.id === id)?.name ??
        t["com.myoxus.database.row_detail.unavailable"]();
      let localValue: unknown = {
        config,
        name: view.name,
        viewKind: section === "advanced" ? viewKind : view.viewKind,
      };
      if (view.viewKind === DatabaseViewKind.Gantt) {
        // Describe the owned intent, not field IDs or the transport config.
        if (section === "fields") {
          localValue = [
            `${t["com.myoxus.database.gantt.start-field"]()}: ${fieldName(timelineStartFieldId)}`,
            `${t["com.myoxus.database.gantt.end-field"]()}: ${timelineEndFieldId ? fieldName(timelineEndFieldId) : t["com.myoxus.database.schedule.use-start-range"]()}`,
            `${t["com.myoxus.database.gantt.dependency-relation"]()}: ${ganttDependencyFieldId ? fieldName(ganttDependencyFieldId) : t["com.myoxus.database.gantt.no-dependency"]()}`,
            `${t["com.myoxus.database.view.visible-fields"]()}: ${visibleFieldIds.map(fieldName).join(", ")}`,
          ].join("\n");
        } else if (section === "display") {
          localValue = `${t["com.myoxus.database.schedule.zoom"]()}: ${databaseTimelineZoomLabel(t, timelineZoom)}`;
        } else if (section === "group") {
          const yesNo = (value: boolean) =>
            value ? t["admin.common.yes"]() : t["admin.common.no"]();
          localValue = [
            `${t["com.myoxus.database.gantt.group-field"]()}: ${groupFieldId ? fieldName(groupFieldId) : t["com.myoxus.page.display.grouping.no-grouping"]()}`,
            `${t["com.myoxus.database.view.group-descending"]()}: ${yesNo(groupDescending)}`,
            `${t["com.myoxus.database.view.show-empty-groups"]()}: ${yesNo(showEmptyGroups)}`,
          ].join("\n");
        }
      }
      if (view.viewKind === DatabaseViewKind.Timeline) {
        if (section === "fields")
          localValue = [
            `${t["Title"]()}: ${fieldName(view.config.timeline!.titleFieldId)}`,
            `${t["com.myoxus.database.view.timeline-start"]()}: ${fieldName(timelineStartFieldId)}`,
            `${t["com.myoxus.database.view.timeline-end"]()}: ${timelineEndFieldId ? fieldName(timelineEndFieldId) : t["com.myoxus.database.schedule.use-start-range"]()}`,
            `${t["com.myoxus.database.view.visible-fields"]()}: ${visibleFieldIds.map(fieldName).join(", ")}`,
          ].join("\n");
        else if (section === "display")
          localValue = [
            `${t["com.myoxus.database.schedule.zoom"]()}: ${databaseTimelineZoomLabel(t, timelineZoom)}`,
            `${t["com.myoxus.database.view.timeline-group"]()}: ${databaseTimelineGroupLabel(t, timelineGroupBy)}`,
            `${t["com.myoxus.database.timeline.group-order"]()}: ${timelineOrder === DatabaseTimelineOrder.Asc ? t["com.myoxus.database.view.sort-ascending"]() : t["com.myoxus.database.view.sort-descending"]()}`,
          ].join("\n");
      }
      const result = await executeRevisionMutation(
        conflicts,
        async (variables: UpdateDatabaseViewMutationVariables) => {
          if (!variables.input.force) return updateView.trigger(variables);
          // Force applies this section's captured intent only. Refresh the
          // unowned config, name and icon, then guard that read with its actual
          // revision instead of a whole-record force write that could erase it.
          const response = await graphqlService.gql({
            query: databaseViewQuery,
            variables: {
              workspaceId: record.database.workspaceId,
              databaseId,
              viewId: view.id,
            },
          });
          const latest = response.workspace?.databaseView;
          if (!latest || latest.viewKind !== view.viewKind)
            throw new Error("Database settings target changed.");
          return updateView.trigger({
            input: {
              ...variables.input,
              config: buildConfig(latest),
              name: latest.name,
              icon:
                section === "advanced"
                  ? variables.input.icon
                  : latest.icon?.emoji
                    ? { emoji: latest.icon.emoji }
                    : latest.icon?.system
                      ? { system: latest.icon.system }
                      : null,
              expectedEditRevision: latest.editRevision,
              force: false,
            },
          });
        },
        {
          databaseId,
          viewId: view.id,
          config,
          icon:
            section === "advanced"
              ? iconMode === "emoji"
                ? { emoji: iconEmoji }
                : iconMode === "system"
                  ? { system: iconSystem }
                  : null
              : view.icon?.emoji
                ? { emoji: view.icon.emoji }
                : view.icon?.system
                  ? { system: view.icon.system }
                  : null,
          name: view.name,
          viewKind: section === "advanced" ? viewKind : view.viewKind,
          expectedEditRevision: draftViewRevisionRef.current,
        },
        {
          attemptedAction: t["com.myoxus.database.view.settings"](),
          localValue,
          reloadLatest: async () => {
            await onChanged();
            if (draftOwnerRef.current !== draftOwner) return;
            draftDirtyRef.current = false;
            // An equal cached View may not rerun the initialization effect.
            // Explicit Reload must still discard this section's local values.
            setReloadRevision((revision) => revision + 1);
            setSaveStatus("idle");
          },
          afterSuccess: async (result) => {
            if (draftOwnerRef.current === draftOwner) {
              // Only a confirmed own write advances the basis. Clear dirty
              // before readback so its View update can initialize the next edit.
              draftViewRevisionRef.current =
                result.updateDatabaseView.editRevision;
              draftDirtyRef.current = false;
            }
            await onChanged({
              kind: "view_updated",
              target: { viewId: view.id },
            });
          },
          afterForceSuccess: async (result) => {
            if (draftOwnerRef.current === draftOwner) {
              draftViewRevisionRef.current =
                result.updateDatabaseView.editRevision;
              draftDirtyRef.current = false;
            }
            await onChanged({
              kind: "view_updated",
              target: { viewId: view.id },
            });
            if (draftOwnerRef.current !== draftOwner) return;
            setSaveStatus("saved");
            onSaved?.();
          },
        },
      );
      if (draftOwnerRef.current !== draftOwner) return;
      if (!result) {
        setSaveStatus("conflict");
        return;
      }
      draftDirtyRef.current = false;
      setSaveStatus("saved");
      onSaved?.();
    } catch {
      if (draftOwnerRef.current === draftOwner) setSaveStatus("failure");
    } finally {
      savePendingRef.current = false;
    }
  }, [
    canWrite,
    databaseId,
    draftOwner,
    calendarDateFieldId,
    calendarDateMode,
    calendarInitialRange,
    cardDensity,
    conflicts,
    coverFieldId,
    effectiveState,
    filterTree,
    fieldWidths,
    galleryCardDensity,
    graphqlService,
    groupDescending,
    groupFieldId,
    iconEmoji,
    iconMode,
    iconSystem,
    listDensity,
    onChanged,
    onEffectiveStateChanged,
    onSaved,
    personalQueryEdit,
    progressFieldId,
    record,
    searchFieldIds,
    showEmptyGroups,
    section,
    sortRules,
    showEmptyCover,
    showFieldLabels,
    showEmptySubgroups,
    subgroupFieldId,
    subgroupDescending,
    supportsGroupRules,
    t,
    timelineEndFieldId,
    timelineGroupBy,
    timelineOrder,
    timelineStartFieldId,
    timelineZoom,
    ganttDependencyFieldId,
    updateView,
    upsertPersonalState,
    view,
    viewKind,
    visibleFieldIds,
  ]);

  const statusLabel =
    saveStatus === "dirty"
      ? t["com.myoxus.database.view.unsaved"]()
      : saveStatus === "saving"
        ? t["common.saving"]()
        : saveStatus === "saved"
          ? t["com.myoxus.database.view.saved"]()
          : saveStatus === "conflict"
            ? t["com.myoxus.database.conflict.title"]()
            : saveStatus === "failure"
              ? t["com.myoxus.database.view.update-failed"]()
              : null;
  const statusTone =
    saveStatus === "saved"
      ? ("success" as const)
      : saveStatus === "failure" || saveStatus === "conflict"
        ? ("error" as const)
        : ("info" as const);

  return (
    <Stack gap="md" data-testid={`database-view-settings-${section}`}>
      <FormFieldset
        disabled={!canWrite || saveStatus === "saving"}
        variant="unstyled"
        onChange={markDirty}
      >
        <Stack gap="md">
          {section === "filter" || section === "sort" ? (
            <MyoxusSegmentedControl
              aria-label={t["com.myoxus.database.view.scope"]()}
              data={
                effectiveState.canEditShared
                  ? [
                      {
                        label: t["com.myoxus.database.view.scope.shared"](),
                        value: "shared",
                      },
                      {
                        label: t["com.myoxus.database.view.scope.personal"](),
                        value: "personal",
                      },
                    ]
                  : [
                      {
                        label: t["com.myoxus.database.view.scope.personal"](),
                        value: "personal",
                      },
                    ]
              }
              value={effectiveState.canEditShared ? editScope : "personal"}
              onChange={(scope) =>
                effectiveState.canEditShared &&
                onEditScopeChange(scope as DatabaseViewEditScope)
              }
            />
          ) : null}
          {section === "fields" ||
          section === "display" ||
          section === "advanced" ? (
            <Stack gap="md">
              {section === "advanced" ? (
                <Stack gap="md">
                  <FormRow label={t["com.myoxus.database.view.type"]()}>
                    <Select
                      aria-label={t["com.myoxus.database.view.type"]()}
                      data={Object.values(DatabaseViewKind).map((kind) => ({
                        label: databaseViewKindLabel(t, kind),
                        value: kind,
                        disabled: !databaseViewKindIsAvailable(record, kind),
                      }))}
                      value={viewKind}
                      onChange={(value) =>
                        value &&
                        updateDraft(setViewKind, value as DatabaseViewKind)
                      }
                      block
                    />
                  </FormRow>
                  <FormRow label={t["com.myoxus.database.view.icon"]()}>
                    <Stack gap="sm">
                      <MyoxusSegmentedControl
                        aria-label={t["com.myoxus.database.view.icon"]()}
                        data={[
                          {
                            label: t["com.myoxus.database.view.icon.default"](),
                            value: "default",
                          },
                          {
                            label: t["com.myoxus.database.view.icon.system"](),
                            value: "system",
                          },
                          {
                            label: t["com.myoxus.database.view.icon.emoji"](),
                            value: "emoji",
                          },
                        ]}
                        value={iconMode}
                        onChange={(mode) =>
                          updateDraft(
                            setIconMode,
                            mode as "default" | "emoji" | "system",
                          )
                        }
                      />
                      {iconMode === "system" ? (
                        <Select
                          aria-label={t[
                            "com.myoxus.database.view.icon.system"
                          ]()}
                          data={Object.values(DatabaseViewSystemIcon).map(
                            (value) => ({
                              label: databaseViewSystemIconLabel(t, value),
                              value,
                            }),
                          )}
                          value={iconSystem}
                          onChange={(value) =>
                            value &&
                            updateDraft(
                              setIconSystem,
                              value as DatabaseViewSystemIcon,
                            )
                          }
                          block
                        />
                      ) : null}
                      {iconMode === "emoji" ? (
                        <Input
                          aria-label={t[
                            "com.myoxus.database.view.icon.emoji"
                          ]()}
                          value={iconEmoji}
                          onChange={(value) => updateDraft(setIconEmoji, value)}
                        />
                      ) : null}
                    </Stack>
                  </FormRow>
                </Stack>
              ) : null}
              {section === "fields" ? (
                <Stack
                  gap="xs"
                  aria-label={t["com.myoxus.database.view.visible-fields"]()}
                  data-myoxus-ui-role="database-visible-field-list"
                >
                  <FormRow label={t["com.myoxus.database.view.show-field"]()}>
                    <Select
                      aria-label={t["com.myoxus.database.view.show-field"]()}
                      data={fieldOptions.filter(
                        (option) => !visibleFieldIds.includes(option.value),
                      )}
                      value={null}
                      onChange={(fieldId) => {
                        if (!fieldId) return;
                        markDirty();
                        updateDraft(setVisibleFieldIds, (current) => [
                          ...current,
                          fieldId,
                        ]);
                      }}
                      disabled={fieldOptions.every((option) =>
                        visibleFieldIds.includes(option.value),
                      )}
                      placeholder={t["com.myoxus.database.view.show-field"]()}
                      block
                    />
                  </FormRow>
                  {visibleFieldIds.map((fieldId, index) => {
                    const field = getFieldById(record, fieldId);
                    if (!field) return null;
                    const isProtected =
                      field.fieldType === DatabaseFieldKind.Title ||
                      (view.viewKind === DatabaseViewKind.Kanban &&
                        field.id === view.config.kanban?.groupFieldId);
                    return (
                      <Stack
                        key={fieldId}
                        gap="xs"
                        data-myoxus-ui-role="database-visible-field-row"
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <MyoxusText
                            component="span"
                            typographySlot="body-small"
                          >
                            {field.name}
                          </MyoxusText>
                          <Group gap="xs" wrap="nowrap">
                            <IconButton
                              aria-label={`${t["com.myoxus.database.filter.move-up"]()}: ${field.name}`}
                              disabled={index === 0}
                              size="small"
                              variant="plain"
                              onClick={() => {
                                markDirty();
                                setVisibleFieldIds((current) =>
                                  moveDatabaseFilterItem(current, index, -1),
                                );
                              }}
                            >
                              <ArrowUpSmallIcon />
                            </IconButton>
                            <IconButton
                              aria-label={`${t["com.myoxus.database.filter.move-down"]()}: ${field.name}`}
                              disabled={index === visibleFieldIds.length - 1}
                              size="small"
                              variant="plain"
                              onClick={() => {
                                markDirty();
                                setVisibleFieldIds((current) =>
                                  moveDatabaseFilterItem(current, index, 1),
                                );
                              }}
                            >
                              <ArrowDownSmallIcon />
                            </IconButton>
                            <IconButton
                              aria-label={`${t["common.hide"]()}: ${field.name}`}
                              disabled={isProtected}
                              size="small"
                              variant="plain"
                              onClick={() => {
                                markDirty();
                                setVisibleFieldIds((current) =>
                                  current.filter(
                                    (candidate) => candidate !== fieldId,
                                  ),
                                );
                              }}
                            >
                              <CloseIcon />
                            </IconButton>
                          </Group>
                        </Group>
                        {index < visibleFieldIds.length - 1 ? (
                          <Divider />
                        ) : null}
                      </Stack>
                    );
                  })}
                </Stack>
              ) : null}
              {section === "display" &&
              view.viewKind === DatabaseViewKind.Table ? (
                <Stack gap="md">
                  <FormRow
                    label={t["com.myoxus.database.view.search-fields"]()}
                  >
                    <MultiSelect
                      aria-label={t["com.myoxus.database.view.search-fields"]()}
                      data={sortByPosition(record.fields)
                        .filter(databaseFieldSupportsSearch)
                        .map((field) => ({
                          label: field.name,
                          value: field.id,
                        }))}
                      value={searchFieldIds}
                      onChange={(value) =>
                        updateDraft(setSearchFieldIds, value)
                      }
                      block
                    />
                  </FormRow>
                  {visibleFieldIds.map((fieldId) => {
                    const field = getFieldById(record, fieldId);
                    if (!field) return null;
                    const width = fieldWidths.find(
                      (candidate) => candidate.fieldId === fieldId,
                    )?.width;
                    return (
                      <FormRow
                        key={fieldId}
                        label={`${t["com.myoxus.database.view.column-width"]()}: ${field.name}`}
                      >
                        <NumberInput
                          aria-label={`${t["com.myoxus.database.view.column-width"]()}: ${field.name}`}
                          value={width}
                          onChange={(value) => {
                            const nextWidth = Number(value);
                            updateDraft(setFieldWidths, (current) => {
                              const remaining = current.filter(
                                (candidate) => candidate.fieldId !== fieldId,
                              );
                              return Number.isFinite(nextWidth) && nextWidth > 0
                                ? [...remaining, { fieldId, width: nextWidth }]
                                : remaining;
                            });
                          }}
                        />
                      </FormRow>
                    );
                  })}
                </Stack>
              ) : null}
              {section === "display" &&
              view.viewKind === DatabaseViewKind.Gallery ? (
                <FormRow label={t["com.myoxus.database.view.cover-field"]()}>
                  <Select
                    aria-label={t["com.myoxus.database.view.cover-field"]()}
                    data={[
                      {
                        label: t["com.myoxus.database.view.no-cover"](),
                        value: VIEW_SORT_NONE,
                      },
                      ...sortByPosition(record.fields)
                        .filter(
                          (field) =>
                            field.fieldType === DatabaseFieldKind.Files,
                        )
                        .map((field) => ({
                          label: field.name,
                          value: field.id,
                        })),
                    ]}
                    value={coverFieldId ?? VIEW_SORT_NONE}
                    onChange={(value) =>
                      updateDraft(
                        setCoverFieldId,
                        value && value !== VIEW_SORT_NONE ? value : null,
                      )
                    }
                    block
                  />
                </FormRow>
              ) : null}
              {section === "display" &&
              view.viewKind === DatabaseViewKind.Gallery ? (
                <>
                  <FormRow label={t["com.myoxus.database.view.card-density"]()}>
                    <Select
                      aria-label={t["com.myoxus.database.view.card-density"]()}
                      data={Object.values(DatabaseGalleryCardDensity).map(
                        (value) => ({
                          label: databaseDensityLabel(t, value),
                          value,
                        }),
                      )}
                      value={galleryCardDensity}
                      onChange={(value) =>
                        value &&
                        updateDraft(
                          setGalleryCardDensity,
                          value as DatabaseGalleryCardDensity,
                        )
                      }
                      block
                    />
                  </FormRow>
                  <Switch
                    checked={showEmptyCover}
                    onChange={(value) => updateDraft(setShowEmptyCover, value)}
                  >
                    {t["com.myoxus.database.view.show-empty-cover"]()}
                  </Switch>
                </>
              ) : null}
              {section === "display" &&
              view.viewKind === DatabaseViewKind.List ? (
                <>
                  <FormRow label={t["com.myoxus.database.view.list-density"]()}>
                    <Select
                      aria-label={t["com.myoxus.database.view.list-density"]()}
                      data={Object.values(DatabaseListDensity).map((value) => ({
                        label: databaseDensityLabel(t, value),
                        value,
                      }))}
                      value={listDensity}
                      onChange={(value) =>
                        value &&
                        updateDraft(
                          setListDensity,
                          value as DatabaseListDensity,
                        )
                      }
                      block
                    />
                  </FormRow>
                  <Switch
                    checked={showFieldLabels}
                    onChange={(value) => updateDraft(setShowFieldLabels, value)}
                  >
                    {t["com.myoxus.database.view.show-field-labels"]()}
                  </Switch>
                </>
              ) : null}
              {(section === "fields" || section === "display") &&
              view.viewKind === DatabaseViewKind.Calendar ? (
                <>
                  {section === "fields" ? (
                    <FormRow label={t["com.myoxus.database.view.date-field"]()}>
                      <Select
                        aria-label={t["com.myoxus.database.view.date-field"]()}
                        data={sortByPosition(record.fields)
                          .filter((field) =>
                            isDatabaseDateSourceField(field.fieldType),
                          )
                          .map((field) => ({
                            label: field.name,
                            value: field.id,
                          }))}
                        value={calendarDateFieldId}
                        onChange={(value) =>
                          value && updateDraft(setCalendarDateFieldId, value)
                        }
                        block
                      />
                    </FormRow>
                  ) : null}
                  {section === "display" ? (
                    <>
                      <FormRow
                        label={t["com.myoxus.database.view.date-mode"]()}
                      >
                        <MyoxusSegmentedControl
                          aria-label={t["com.myoxus.database.view.date-mode"]()}
                          data={Object.values(DatabaseCalendarDateMode).map(
                            (value) => ({
                              label: databaseCalendarDateModeLabel(t, value),
                              value,
                            }),
                          )}
                          value={calendarDateMode}
                          onChange={(value) =>
                            updateDraft(
                              setCalendarDateMode,
                              value as DatabaseCalendarDateMode,
                            )
                          }
                        />
                      </FormRow>
                      <FormRow
                        label={t["com.myoxus.database.view.initial-range"]()}
                      >
                        <Select
                          aria-label={t[
                            "com.myoxus.database.view.initial-range"
                          ]()}
                          data={Object.values(DatabaseCalendarInitialRange).map(
                            (value) => ({
                              label:
                                value === DatabaseCalendarInitialRange.Today
                                  ? databaseRelativeDatePresetLabel(
                                      t,
                                      DatabaseRelativeDatePreset.Today,
                                    )
                                  : value ===
                                      DatabaseCalendarInitialRange.CurrentWeek
                                    ? t["com.myoxus.filter.this week"]()
                                    : value ===
                                        DatabaseCalendarInitialRange.CurrentYear
                                      ? t["com.myoxus.filter.this year"]()
                                      : t["com.myoxus.filter.this month"](),
                              value,
                            }),
                          )}
                          value={calendarInitialRange}
                          onChange={(value) =>
                            value &&
                            updateDraft(
                              setCalendarInitialRange,
                              value as DatabaseCalendarInitialRange,
                            )
                          }
                          block
                        />
                      </FormRow>
                    </>
                  ) : null}
                </>
              ) : null}
              {(section === "fields" || section === "display") &&
              (view.viewKind === DatabaseViewKind.Timeline ||
                view.viewKind === DatabaseViewKind.Gantt) ? (
                <>
                  {section === "fields" ? (
                    <>
                      {view.viewKind === DatabaseViewKind.Timeline ? (
                        <FormRow label={t["Title"]()}>
                          <MyoxusText>
                            {
                              getFieldById(
                                record,
                                view.config.timeline?.titleFieldId ?? "",
                              )?.name
                            }
                          </MyoxusText>
                        </FormRow>
                      ) : null}
                      <FormRow
                        label={
                          view.viewKind === DatabaseViewKind.Gantt
                            ? t["com.myoxus.database.gantt.start-field"]()
                            : t["com.myoxus.database.view.timeline-start"]()
                        }
                      >
                        <Select
                          aria-label={
                            view.viewKind === DatabaseViewKind.Gantt
                              ? t["com.myoxus.database.gantt.start-field"]()
                              : t["com.myoxus.database.view.timeline-start"]()
                          }
                          data={sortByPosition(record.fields)
                            .filter(
                              (field) =>
                                isDatabaseDateSourceField(field.fieldType) &&
                                field.id !== timelineEndFieldId,
                            )
                            .map((field) => ({
                              label: isDatabaseProjectionField(field.fieldType)
                                ? `${field.name} (${t["com.myoxus.share-menu.option.link.readonly"]()})`
                                : field.name,
                              value: field.id,
                            }))}
                          value={timelineStartFieldId}
                          onChange={(value) =>
                            value && updateDraft(setTimelineStartFieldId, value)
                          }
                          block
                        />
                      </FormRow>
                      {view.viewKind === DatabaseViewKind.Gantt ? (
                        <FormRow
                          label={t[
                            "com.myoxus.database.gantt.dependency-relation"
                          ]()}
                        >
                          <Select
                            aria-label={t[
                              "com.myoxus.database.gantt.dependency-relation"
                            ]()}
                            data={[
                              {
                                label:
                                  t[
                                    "com.myoxus.database.gantt.no-dependency"
                                  ](),
                                value: VIEW_SORT_NONE,
                              },
                              ...sortByPosition(record.fields)
                                .filter(
                                  (field) =>
                                    field.fieldType ===
                                      DatabaseFieldKind.Relation &&
                                    field.config.relation?.targetDatabaseId ===
                                      record.database.id,
                                )
                                .map((field) => ({
                                  label:
                                    view.viewKind === DatabaseViewKind.Gantt &&
                                    isDatabaseProjectionField(field.fieldType)
                                      ? `${field.name} (${t["com.myoxus.share-menu.option.link.readonly"]()})`
                                      : field.name,
                                  value: field.id,
                                })),
                            ]}
                            value={ganttDependencyFieldId ?? VIEW_SORT_NONE}
                            onChange={(value) =>
                              updateDraft(
                                setGanttDependencyFieldId,
                                value && value !== VIEW_SORT_NONE
                                  ? value
                                  : null,
                              )
                            }
                            block
                          />
                        </FormRow>
                      ) : null}
                      <FormRow
                        label={
                          view.viewKind === DatabaseViewKind.Gantt
                            ? t["com.myoxus.database.gantt.end-field"]()
                            : t["com.myoxus.database.view.timeline-end"]()
                        }
                      >
                        <Select
                          aria-label={
                            view.viewKind === DatabaseViewKind.Gantt
                              ? t["com.myoxus.database.gantt.end-field"]()
                              : t["com.myoxus.database.view.timeline-end"]()
                          }
                          data={[
                            {
                              label:
                                view.viewKind === DatabaseViewKind.Gantt
                                  ? t[
                                      "com.myoxus.database.schedule.use-start-range"
                                    ]()
                                  : t[
                                      "com.myoxus.database.schedule.use-start-range"
                                    ](),
                              value: VIEW_SORT_NONE,
                            },
                            ...sortByPosition(record.fields)
                              .filter(
                                (field) =>
                                  isDatabaseDateSourceField(field.fieldType) &&
                                  field.id !== timelineStartFieldId,
                              )
                              .map((field) => ({
                                label: isDatabaseProjectionField(
                                  field.fieldType,
                                )
                                  ? `${field.name} (${t["com.myoxus.share-menu.option.link.readonly"]()})`
                                  : field.name,
                                value: field.id,
                              })),
                          ]}
                          value={timelineEndFieldId ?? VIEW_SORT_NONE}
                          onChange={(value) =>
                            updateDraft(
                              setTimelineEndFieldId,
                              value && value !== VIEW_SORT_NONE ? value : null,
                            )
                          }
                          block
                        />
                      </FormRow>
                    </>
                  ) : null}
                  {section === "display" ? (
                    <>
                      <FormRow label={t["com.myoxus.database.schedule.zoom"]()}>
                        <Select
                          aria-label={t["com.myoxus.database.schedule.zoom"]()}
                          data={Object.values(DatabaseTimelineZoom).map(
                            (value) => ({
                              label: databaseTimelineZoomLabel(t, value),
                              value,
                            }),
                          )}
                          value={timelineZoom}
                          onChange={(value) =>
                            value &&
                            updateDraft(
                              setTimelineZoom,
                              value as DatabaseTimelineZoom,
                            )
                          }
                          block
                        />
                      </FormRow>
                      {view.viewKind === DatabaseViewKind.Timeline ? (
                        <FormRow
                          label={t["com.myoxus.database.view.timeline-group"]()}
                        >
                          <Select
                            aria-label={t[
                              "com.myoxus.database.view.timeline-group"
                            ]()}
                            data={Object.values(DatabaseTimelineGroupBy).map(
                              (value) => ({
                                label: databaseTimelineGroupLabel(t, value),
                                value,
                              }),
                            )}
                            value={timelineGroupBy}
                            onChange={(value) =>
                              value &&
                              updateDraft(
                                setTimelineGroupBy,
                                value as DatabaseTimelineGroupBy,
                              )
                            }
                            block
                          />
                        </FormRow>
                      ) : null}
                      {view.viewKind === DatabaseViewKind.Timeline ? (
                        <FormRow
                          label={t[
                            "com.myoxus.database.timeline.group-order"
                          ]()}
                        >
                          <Select
                            aria-label={t[
                              "com.myoxus.database.timeline.group-order"
                            ]()}
                            data={[
                              {
                                label:
                                  t[
                                    "com.myoxus.database.view.sort-ascending"
                                  ](),
                                value: DatabaseTimelineOrder.Asc,
                              },
                              {
                                label:
                                  t[
                                    "com.myoxus.database.view.sort-descending"
                                  ](),
                                value: DatabaseTimelineOrder.Desc,
                              },
                            ]}
                            disabled={
                              timelineGroupBy === DatabaseTimelineGroupBy.None
                            }
                            description={
                              timelineGroupBy === DatabaseTimelineGroupBy.None
                                ? t[
                                    "com.myoxus.database.timeline.group-order-inactive"
                                  ]()
                                : undefined
                            }
                            value={timelineOrder}
                            onChange={(value) =>
                              value &&
                              updateDraft(
                                setTimelineOrder,
                                value as DatabaseTimelineOrder,
                              )
                            }
                            block
                          />
                        </FormRow>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : null}
            </Stack>
          ) : null}
          {section === "display" &&
          view.viewKind === DatabaseViewKind.Kanban ? (
            <Stack gap="md">
              <FormRow label={t["com.myoxus.database.view.card-density"]()}>
                <Select
                  aria-label={t["com.myoxus.database.view.card-density"]()}
                  data={Object.values(DatabaseCardDensity).map((value) => ({
                    label: databaseDensityLabel(t, value),
                    value,
                  }))}
                  value={cardDensity}
                  onChange={(value) =>
                    value &&
                    updateDraft(setCardDensity, value as DatabaseCardDensity)
                  }
                  block
                />
              </FormRow>
              <FormRow label={t["com.myoxus.database.view.cover-field"]()}>
                <Select
                  aria-label={t["com.myoxus.database.view.cover-field"]()}
                  data={[
                    {
                      label: t["com.myoxus.database.view.no-cover"](),
                      value: VIEW_SORT_NONE,
                    },
                    ...sortByPosition(record.fields)
                      .filter(
                        (field) => field.fieldType === DatabaseFieldKind.Files,
                      )
                      .map((field) => ({
                        label:
                          view.viewKind === DatabaseViewKind.Gantt &&
                          isDatabaseProjectionField(field.fieldType)
                            ? `${field.name} (${t["com.myoxus.share-menu.option.link.readonly"]()})`
                            : field.name,
                        value: field.id,
                      })),
                  ]}
                  value={coverFieldId ?? VIEW_SORT_NONE}
                  onChange={(value) =>
                    updateDraft(
                      setCoverFieldId,
                      value && value !== VIEW_SORT_NONE ? value : null,
                    )
                  }
                  block
                />
              </FormRow>
            </Stack>
          ) : null}
          {section === "group" && view.viewKind === DatabaseViewKind.Kanban ? (
            <FormRow label={t["com.myoxus.database.view.group-field"]()}>
              <Select
                aria-label={t["com.myoxus.database.view.group-field"]()}
                data={selectFieldOptions}
                value={groupFieldId ?? ""}
                onChange={(value) => updateDraft(setGroupFieldId, value)}
                disabled={!selectFieldOptions.length}
                block
              />
            </FormRow>
          ) : null}
          {section === "fields" &&
          view.viewKind === DatabaseViewKind.Progress ? (
            <Stack gap="sm">
              <FormRow label={t["com.myoxus.database.progress.field"]()}>
                <Select
                  aria-label={t["com.myoxus.database.progress.field"]()}
                  data={progressFieldOptions}
                  value={progressFieldId}
                  onChange={(value) => updateDraft(setProgressFieldId, value)}
                  disabled={!progressFieldOptions.length}
                  block
                />
              </FormRow>
            </Stack>
          ) : null}
          {section === "group" && supportsGroupRules ? (
            <Stack gap="sm">
              <FormRow
                label={
                  view.viewKind === DatabaseViewKind.Gantt
                    ? t["com.myoxus.database.gantt.group-field"]()
                    : t["com.myoxus.page.display.grouping"]()
                }
              >
                <Select
                  aria-label={
                    view.viewKind === DatabaseViewKind.Gantt
                      ? t["com.myoxus.database.gantt.group-field"]()
                      : t["com.myoxus.page.display.grouping"]()
                  }
                  data={[
                    {
                      value: VIEW_SORT_NONE,
                      label:
                        t["com.myoxus.page.display.grouping.no-grouping"](),
                    },
                    ...groupFieldOptions,
                  ]}
                  value={groupFieldId ?? VIEW_SORT_NONE}
                  onChange={(value) => {
                    const next =
                      value && value !== VIEW_SORT_NONE ? value : null;
                    updateDraft(setGroupFieldId, next);
                    if (!next) updateDraft(setSubgroupFieldId, null);
                  }}
                  block
                />
              </FormRow>
              {groupFieldId ? (
                <Group gap="md" wrap="wrap">
                  <Switch
                    checked={groupDescending}
                    onChange={(value) => updateDraft(setGroupDescending, value)}
                  >
                    {t["com.myoxus.database.view.group-descending"]()}
                  </Switch>
                  <Switch
                    checked={showEmptyGroups}
                    onChange={(value) => updateDraft(setShowEmptyGroups, value)}
                  >
                    {t["com.myoxus.database.view.show-empty-groups"]()}
                  </Switch>
                </Group>
              ) : null}
              {groupFieldId && view.viewKind !== DatabaseViewKind.Gantt ? (
                <FormRow label={t["com.myoxus.database.view.subgroup-field"]()}>
                  <Select
                    aria-label={t["com.myoxus.database.view.subgroup-field"]()}
                    data={[
                      {
                        value: VIEW_SORT_NONE,
                        label:
                          t["com.myoxus.page.display.grouping.no-grouping"](),
                      },
                      ...groupFieldOptions.filter(
                        (option) => option.value !== groupFieldId,
                      ),
                    ]}
                    value={subgroupFieldId ?? VIEW_SORT_NONE}
                    onChange={(value) =>
                      updateDraft(
                        setSubgroupFieldId,
                        value && value !== VIEW_SORT_NONE ? value : null,
                      )
                    }
                    block
                  />
                </FormRow>
              ) : null}
              {subgroupFieldId && view.viewKind !== DatabaseViewKind.Gantt ? (
                <Group gap="md" wrap="wrap">
                  <Switch
                    checked={subgroupDescending}
                    onChange={(value) =>
                      updateDraft(setSubgroupDescending, value)
                    }
                  >
                    {t["com.myoxus.database.view.subgroup-descending"]()}
                  </Switch>
                  <Switch
                    checked={showEmptySubgroups}
                    onChange={(value) =>
                      updateDraft(setShowEmptySubgroups, value)
                    }
                  >
                    {t["com.myoxus.database.view.show-empty-subgroups"]()}
                  </Switch>
                </Group>
              ) : null}
            </Stack>
          ) : null}
          {section === "filter" ? (
            <DatabaseFilterGroupEditor
              group={filterTree}
              onChange={(value) => updateDraft(setFilterTree, value)}
              record={record}
              tagOptions={tagOptions}
            />
          ) : null}
          {section === "sort" ? (
            <FormRow label={t["com.myoxus.database.view.sort-field"]()}>
              <Stack gap="xs">
                {sortRules.map((rule, index) => (
                  <Group key={`${rule.fieldId}:${index}`} grow wrap="wrap">
                    <Select
                      aria-label={t["com.myoxus.database.view.sort-field"]()}
                      data={sortFieldOptions.filter(
                        (option) =>
                          option.value === rule.fieldId ||
                          !sortRules.some(
                            (candidate) => candidate.fieldId === option.value,
                          ),
                      )}
                      value={rule.fieldId}
                      onChange={(fieldId) => {
                        if (!fieldId) return;
                        updateDraft(setSortRules, (current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? { ...candidate, fieldId }
                              : candidate,
                          ),
                        );
                      }}
                    />
                    <Select
                      aria-label={t[
                        "com.myoxus.database.view.sort-direction"
                      ]()}
                      data={[
                        {
                          value: DatabaseSortDirection.Asc,
                          label: t["com.myoxus.database.view.sort-ascending"](),
                        },
                        {
                          value: DatabaseSortDirection.Desc,
                          label:
                            t["com.myoxus.database.view.sort-descending"](),
                        },
                      ]}
                      value={rule.direction}
                      onChange={(direction) =>
                        updateDraft(setSortRules, (current) =>
                          current.map((candidate, candidateIndex) =>
                            candidateIndex === index
                              ? {
                                  ...candidate,
                                  direction: direction as DatabaseSortDirection,
                                }
                              : candidate,
                          ),
                        )
                      }
                    />
                    <IconButton
                      aria-label={t["com.myoxus.database.view.sort-move-up"]()}
                      disabled={index === 0}
                      size="small"
                      variant="plain"
                      onClick={() => {
                        markDirty();
                        setSortRules((current) =>
                          moveDatabaseFilterItem(current, index, -1),
                        );
                      }}
                    >
                      <ArrowUpSmallIcon />
                    </IconButton>
                    <IconButton
                      aria-label={t[
                        "com.myoxus.database.view.sort-move-down"
                      ]()}
                      disabled={index === sortRules.length - 1}
                      size="small"
                      variant="plain"
                      onClick={() => {
                        markDirty();
                        setSortRules((current) =>
                          moveDatabaseFilterItem(current, index, 1),
                        );
                      }}
                    >
                      <ArrowDownSmallIcon />
                    </IconButton>
                    <IconButton
                      aria-label={`${t["Delete"]()}: ${
                        sortFieldOptions.find(
                          (option) => option.value === rule.fieldId,
                        )?.label ?? rule.fieldId
                      }`}
                      size="small"
                      variant="plain"
                      onClick={() => {
                        markDirty();
                        setSortRules((current) =>
                          current.filter(
                            (_, candidateIndex) => candidateIndex !== index,
                          ),
                        );
                      }}
                    >
                      <TrashIcon />
                    </IconButton>
                  </Group>
                ))}
                <Button
                  variant="secondary"
                  prefix={<PlusIcon />}
                  disabled={sortFieldOptions.every((option) =>
                    sortRules.some((rule) => rule.fieldId === option.value),
                  )}
                  onClick={() => {
                    markDirty();
                    const field = sortFieldOptions.find(
                      (option) =>
                        !sortRules.some(
                          (rule) => rule.fieldId === option.value,
                        ),
                    );
                    if (field) {
                      setSortRules((current) => [
                        ...current,
                        {
                          direction: DatabaseSortDirection.Asc,
                          fieldId: field.value,
                        },
                      ]);
                    }
                  }}
                >
                  {t["com.myoxus.database.view.add-sort"]()}
                </Button>
              </Stack>
            </FormRow>
          ) : null}
        </Stack>
      </FormFieldset>
      <Group
        justify={statusLabel ? "space-between" : "flex-end"}
        gap="xs"
        wrap="wrap"
      >
        {statusLabel ? (
          <Badge
            tone={statusTone}
            data-testid="database-view-settings-status"
            aria-live="polite"
          >
            {statusLabel}
          </Badge>
        ) : null}
        <Group justify="flex-end" gap="xs">
          {showCancel ? (
            <Button variant="secondary" onClick={onCancel}>
              {t["Cancel"]()}
            </Button>
          ) : null}
          <Button
            onClick={() => void save()}
            loading={
              saveStatus === "saving" ||
              updateView.isMutating ||
              upsertPersonalState.isMutating
            }
            disabled={
              !canWrite ||
              saveStatus === "saving" ||
              (section === "advanced" &&
                iconMode === "emoji" &&
                !iconEmoji.trim())
            }
          >
            {t["Save"]()}
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

export function ViewSettingsModal({
  databaseId,
  effectiveState,
  editScope,
  onChanged,
  onClose,
  onEditScopeChange,
  onEffectiveStateChanged,
  open,
  record,
  returnFocusRef,
  section,
  view,
}: {
  databaseId: string;
  effectiveState: DatabaseEffectiveViewState;
  editScope: DatabaseViewEditScope;
  onChanged: DatabaseChangeHandler;
  onClose: () => void;
  onEditScopeChange: (scope: DatabaseViewEditScope) => void;
  onEffectiveStateChanged: () => Promise<void>;
  open: boolean;
  record: DatabaseRecord;
  returnFocusRef?: RefObject<HTMLElement | null>;
  section: DatabaseViewControlSection;
  view: DatabaseView;
}) {
  const t = useI18n();
  return (
    <Modal
      open={open}
      scrollable
      returnFocusRef={returnFocusRef}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title={databaseViewControlTitle(t, section)}
      contentOptions={{ "data-testid": "database-view-settings-modal" }}
    >
      <ViewSettingsSectionEditor
        active={open}
        databaseId={databaseId}
        effectiveState={effectiveState}
        editScope={editScope}
        onCancel={onClose}
        onChanged={onChanged}
        onEditScopeChange={onEditScopeChange}
        onEffectiveStateChanged={onEffectiveStateChanged}
        onSaved={onClose}
        record={record}
        section={section}
        showCancel
        view={view}
      />
    </Modal>
  );
}
