// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseFieldKind,
  type DatabaseRowGroupSummaryFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Stack,
  Text,
  Group,
  Modal,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  type GanttCreateDraft,
  type GanttMoveIntent,
  type GanttDependencyView,
  EmptyState,
  GanttView,
  Loading,
  useConfirmModal,
  MyoxusTextInput,
  notify,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getVisibleFieldIds,
  getFieldById,
  isDatabaseProjectionField,
} from "../model";
import {
  DatabaseViewFieldValues,
  DatabaseRowActionMenu,
  useDeleteDatabaseRowAction,
  useDatabaseRowDetail,
} from "../row-detail";
import type { DatabaseScheduleInterval } from "../shared/schedule-values";
import type { DatabaseViewPrimaryAction } from "../shared";
import type { DatabaseChangeHandler } from "../shared/change-invalidation";
import type {
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseView,
  DatabaseField,
} from "../types";
import {
  ganttMoveCells,
  ganttDependencyPatches,
  type GanttDependencyIntent,
  useGanttMutations,
} from "./mutations";
import { projectDatabaseGantt } from "./projection";
import {
  DatabasePresenceTarget,
  useDatabasePresenceContext,
} from "../presence";

const diagnosticKeys = {
  "missing-start": "com.myoxus.database.schedule.missing-start",
  "invalid-start": "com.myoxus.database.schedule.invalid-start",
  "missing-end": "com.myoxus.database.schedule.missing-end",
  "invalid-end": "com.myoxus.database.schedule.invalid-end",
  "end-before-start": "com.myoxus.database.schedule.end-before-start",
} as const;

/** The same Database adapter is consumed by Workbench and persisted embeds. */
export function DatabaseGanttView({
  canEdit,
  loading = false,
  collapsedGroupKeys,
  onToggleGroup,
  databaseId,
  date,
  hasActiveQuery = false,
  onConfigureFields,
  onClearQuery,
  onShowToday,
  onChanged,
  onToolbarActionChange,
  record,
  rows,
  rowGroups,
  view,
}: {
  canEdit: boolean;
  loading?: boolean;
  collapsedGroupKeys?: readonly string[];
  onToggleGroup?: (groupKey: string, collapsed: boolean) => void;
  databaseId: string;
  date: string;
  hasActiveQuery?: boolean;
  onConfigureFields?: () => void;
  onClearQuery?: () => void;
  onShowToday?: () => void;
  onChanged: DatabaseChangeHandler;
  onToolbarActionChange?: (action: DatabaseViewPrimaryAction | null) => void;
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
  rowGroups?: DatabaseRowGroupSummaryFragment[];
  view: DatabaseView;
}) {
  const t = useI18n();
  const { openConfirmModal } = useConfirmModal();
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  const deleteNeighboursRef = useRef(new Map<string, string | null>());
  const detail = useDatabaseRowDetail();
  const presence = useDatabasePresenceContext();
  const mutations = useGanttMutations(databaseId, onChanged);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [createdRowToFocus, setCreatedRowToFocus] = useState<string | null>(
    null,
  );
  const [selectedDependencyId, setSelectedDependencyId] = useState<
    string | null
  >(null);
  type MoveBasis = {
    item: DatabaseScheduleInterval;
    start: DatabaseField;
    end: DatabaseField | null;
    group: DatabaseField | null;
    sourceKey: string;
  };
  const moveBasisRef = useRef<MoveBasis | null>(null);
  const updatePresenceFocus = presence?.updateFocus;
  useEffect(
    () => () => {
      if (moveBasisRef.current) updatePresenceFocus?.({ dragging: false });
    },
    [updatePresenceFocus],
  );
  const [moveDateChoice, setMoveDateChoice] = useState<{
    basis: MoveBasis;
    intent: GanttMoveIntent;
  } | null>(null);
  const [moveGroupDate, setMoveGroupDate] = useState<string | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const dependencyBasisRef = useRef<{
    rows: Map<string, DatabaseRowRecord>;
    geometries: Map<string, GanttDependencyView>;
    labels: Map<string, string>;
    edges: Map<
      string,
      {
        dependent: DatabaseRowRecord;
        prerequisiteId: string;
        businessId: string;
      }
    >;
    field: DatabaseField;
  } | null>(null);
  const [dependencyDraft, setDependencyDraft] = useState<{
    field: DatabaseField;
    intent: GanttDependencyIntent;
    preview: GanttDependencyView;
    focusTaskId: string;
    description: string;
  } | null>(null);
  const [savingDependency, setSavingDependency] = useState(false);
  const [placing, setPlacing] = useState(false);
  const createBasisRef = useRef<{
    record: DatabaseRecord;
    view: DatabaseView;
  } | null>(null);
  const [createDraft, setCreateDraft] = useState<GanttCreateDraft | null>(null);
  const [createChosen, setCreateChosen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [groupDate, setGroupDate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [savingTitle, setSavingTitle] = useState(false);
  const [rename, setRename] = useState<{
    taskId: string;
    row: DatabaseRowRecord;
    titleFieldId: string;
    value: string;
  } | null>(null);
  const projection = projectDatabaseGantt({
    record,
    rows,
    rowGroups,
    view,
    date,
    locale: t.language,
    canEdit,
    selectedRowId,
    collapsedGroupKeys,
    ungroupedLabel: t["com.myoxus.page.display.grouping.no-grouping"](),
    readonlyReason: t["com.myoxus.database.temporal.projection-readonly"](),
    unavailableLabel: t["com.myoxus.database.row_detail.unavailable"](),
  });
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  useEffect(() => {
    if (!createdRowToFocus) return;
    const task = projection.tasks.find(
      (task) =>
        projection.intervalById.get(task.id)?.row.row.id === createdRowToFocus,
    );
    if (task) {
      restoreFocus(task.id);
    } else {
      rootRef.current?.focus();
      notify.success({
        title: t["com.myoxus.database.gantt.created-outside-view"](),
        actions: [
          {
            label: t["com.myoxus.database.row.open-details"](),
            onClick: () =>
              detail?.openById?.(createdRowToFocus, rootRef.current),
          },
        ],
      });
    }
    setCreatedRowToFocus(null);
  }, [createdRowToFocus, projection.tasks, projection.intervalById, detail, t]);
  const groupField = getFieldById(
    record,
    view.config.gantt?.group?.fieldId ?? "",
  );
  const canCreate = Boolean(
    canEdit &&
    !loading &&
    projection.startField &&
    !isDatabaseProjectionField(projection.startField.fieldType) &&
    (!projection.endField ||
      !isDatabaseProjectionField(projection.endField.fieldType)) &&
    (!groupField || !isDatabaseProjectionField(groupField.fieldType)) &&
    projection.sections.length,
  );
  const createRangeReadonly = Boolean(
    projection.endField &&
    isDatabaseProjectionField(projection.endField.fieldType),
  );
  const beginPlace = useCallback(() => {
    // Keep the selected fields/group rule from the opening intent. A remote
    // settings change must not silently retarget this local Create draft.
    createBasisRef.current = { record, view };
    setPlacing(true);
    setCreateDraft(null);
    setCreateChosen(false);
    setCreateTitle("");
    setGroupDate(null);
  }, [record, view]);
  useEffect(() => {
    onToolbarActionChange?.({
      label: t["com.myoxus.database.row.add"](),
      disabled: !canCreate || creating,
      disabledReason:
        creating || loading
          ? t["Loading"]()
          : !canEdit
            ? t["com.myoxus.database.gantt.create-denied"]()
            : !projection.startField
              ? t["com.myoxus.database.gantt.invalid-config"]()
              : !canCreate
                ? t["com.myoxus.database.temporal.projection-readonly"]()
                : undefined,
      onSelect: beginPlace,
    });
    return () => onToolbarActionChange?.(null);
  }, [
    beginPlace,
    canCreate,
    canEdit,
    creating,
    loading,
    onToolbarActionChange,
    projection.startField,
    t,
  ]);
  const cancelCreate = () => {
    createBasisRef.current = null;
    setPlacing(false);
    setCreateDraft(null);
    setCreateChosen(false);
    rootRef.current
      ?.querySelector<HTMLElement>('[data-myoxus-ui-role="gantt-axis-scroll"]')
      ?.focus();
  };
  const confirmCreate = async () => {
    const basis = createBasisRef.current;
    if (
      !basis ||
      !canCreate ||
      !createDraft ||
      !createTitle.trim() ||
      creating ||
      createRangeReadonly
    )
      return;
    setCreating(true);
    try {
      const rowId = await mutations.create(
        basis.record,
        basis.view,
        createDraft,
        createTitle,
        groupDate ?? undefined,
      );
      if (rowId) {
        setSelectedRowId(rowId);
        setCreatedRowToFocus(rowId);
      }
      cancelCreate();
    } catch (error) {
      if (!(
        error instanceof Error &&
        ["group-date-required", "invalid-lane"].includes(error.message)
      ))
        cancelCreate();
      notify.error({
        title: t["com.myoxus.database.gantt.create-failed"](),
        message:
          error instanceof Error && error.message === "group-date-required"
            ? t["com.myoxus.database.gantt.group-date-required"]()
            : error instanceof Error && error.message === "invalid-lane"
              ? t["com.myoxus.database.gantt.invalid-lane"]()
              : undefined,
        actions: [
          {
            label: t["com.myoxus.database.conflict.reload"](),
            onClick: async () => {
              cancelCreate();
              await onChanged();
            },
          },
        ],
      });
    } finally {
      setCreating(false);
    }
  };
  const commitMove = async (
    basis: MoveBasis,
    intent: GanttMoveIntent,
    exactDate?: string,
  ) => {
    if (savingRowId) return;
    try {
      ganttMoveCells(
        basis.item,
        basis.start,
        basis.end,
        intent,
        basis.group,
        basis.sourceKey,
        exactDate,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "group-date-required") {
        setMoveDateChoice({ basis, intent });
        setMoveGroupDate(null);
        return;
      }
      notify.error({
        title:
          error instanceof Error && error.message === "end-before-start"
            ? t["com.myoxus.database.schedule.end-before-start"]()
            : t["com.myoxus.database.gantt.invalid-lane"](),
      });
      restoreFocus(intent.taskId);
      return;
    }
    setSavingRowId(basis.item.row.row.id);
    try {
      await mutations.schedule(
        basis.item,
        basis.start,
        basis.end,
        intent,
        basis.group,
        basis.sourceKey,
        exactDate,
        projection.sections.find(
          (section) => section.id === intent.targetLaneId,
        )?.label,
        () => restoreRowFocus(basis.item.row.row.id, intent.taskId),
      );
      setMoveDateChoice(null);
    } catch {
      setMoveDateChoice(null);
      notify.error({
        title: t["com.myoxus.database.gantt.schedule-failed"](),
        actions: [
          {
            label: t["com.myoxus.database.conflict.reload"](),
            onClick: () => onChanged(),
          },
        ],
      });
    } finally {
      setSavingRowId(null);
      restoreRowFocus(basis.item.row.row.id, intent.taskId);
    }
  };
  const closeDependency = () => {
    if (dependencyDraft) restoreFocus(dependencyDraft.focusTaskId);
    setDependencyDraft(null);
  };
  const dependencyLabel = (id: string) =>
    projection.pinnedRows.find((task) => task.id === id)?.label ??
    projection.externalEndpoints.find((endpoint) => endpoint.id === id)
      ?.label ??
    t["com.myoxus.database.row_detail.unavailable"]();
  const proposeDependency = (
    field: DatabaseField,
    intent: GanttDependencyIntent,
    preview: GanttDependencyView,
    focusTaskId: string,
    description: string,
  ) => {
    if (!canEdit || savingDependency) return;
    try {
      if (!ganttDependencyPatches(field, intent).length) return;
      setDependencyDraft({
        field,
        intent,
        preview: {
          ...preview,
          preview: true,
          selected: true,
          edit: { enabled: false },
        },
        focusTaskId,
        // Keep readable opening labels when filtering hides either endpoint.
        description,
      });
    } catch {
      notify.error({
        title: t["com.myoxus.database.gantt.invalid-dependency"](),
      });
      restoreFocus(focusTaskId);
    }
  };
  const confirmDependency = async () => {
    if (!dependencyDraft || savingDependency || !canEdit) return;
    setSavingDependency(true);
    try {
      await mutations.dependency(
        dependencyDraft.field,
        dependencyDraft.intent,
        closeDependency,
        dependencyDraft.description,
      );
      closeDependency();
    } catch {
      closeDependency();
      notify.error({
        title: t["com.myoxus.database.gantt.dependency-failed"](),
        actions: [
          {
            label: t["com.myoxus.database.conflict.reload"](),
            onClick: () => onChanged(),
          },
        ],
      });
    } finally {
      setSavingDependency(false);
    }
  };
  const metadataFields = getVisibleFieldIds(record, view)
    .filter(
      (id) =>
        ![
          view.config.gantt?.titleFieldId,
          projection.startField?.id,
          projection.endField?.id,
          projection.dependencyField?.id,
        ].includes(id),
    )
    .flatMap((id) => {
      const field = getFieldById(record, id);
      return field ? [field] : [];
    });
  const focusTarget = (id: string) => {
    // Membership IDs are opaque tuples; compare attributes directly instead
    // of interpolating quotes and delimiters into a CSS selector.
    const candidates = rootRef.current?.querySelectorAll<HTMLElement>(
      '[data-testid^="gantt-bar-"], [data-testid^="gantt-label-"]',
    );
    if (!candidates) return null;
    return (
      [...candidates].find(
        (element) => element.dataset.testid === `gantt-bar-${id}`,
      ) ??
      [...candidates].find(
        (element) => element.dataset.testid === `gantt-label-${id}`,
      ) ??
      null
    );
  };
  const restoreFocus = (taskId: string) => {
    requestAnimationFrame(() => focusTarget(taskId)?.focus());
  };
  const restoreRowFocus = (rowId: string, preferredId: string) => {
    requestAnimationFrame(() => {
      const target =
        focusTarget(preferredId) ??
        [...projectionRef.current.rowByProjectionId]
          .filter(([, row]) => row.row.id === rowId)
          .map(([id]) => focusTarget(id))
          .find((element) => element !== null && element !== undefined);
      (target ?? rootRef.current)?.focus();
    });
  };
  const closeRename = () => {
    if (rename) restoreRowFocus(rename.row.row.id, rename.taskId);
    setRename(null);
  };
  const rowFor = (id: string) => projection.rowByProjectionId.get(id);
  const deleteRow = useDeleteDatabaseRowAction(
    databaseId,
    onChanged,
    (rowId) => {
      const nextId = deleteNeighboursRef.current.get(rowId);
      deleteNeighboursRef.current.delete(rowId);
      setSelectedDependencyId(null);
      setSelectedRowId(
        nextId
          ? (projection.rowByProjectionId.get(nextId)?.row.id ?? null)
          : null,
      );
      deleteReturnFocusRef.current = nextId
        ? (focusTarget(nextId) ?? rootRef.current)
        : rootRef.current;
      deleteReturnFocusRef.current?.focus();
    },
  );
  const requestDelete = (id: string) => {
    const row = rowFor(id);
    if (!canEdit || !row || row.redacted || row.row.deletedAt || savingRowId)
      return;
    const visibleTasks = projection.sections
      .filter((section) => !section.collapsed)
      .flatMap((section) =>
        projection.pinnedRows.filter((task) => task.sectionId === section.id),
      );
    const index = visibleTasks.findIndex((task) => task.id === id);
    const next =
      visibleTasks
        .slice(index + 1)
        .find((task) => rowFor(task.id)?.row.id !== row.row.id) ??
      visibleTasks
        .slice(0, index)
        .reverse()
        .find((task) => rowFor(task.id)?.row.id !== row.row.id);
    deleteNeighboursRef.current.set(row.row.id, next?.id ?? null);
    deleteReturnFocusRef.current = focusTarget(id) ?? rootRef.current;
    openConfirmModal({
      returnFocusRef: deleteReturnFocusRef,
      title: t["com.myoxus.database.row.delete"](),
      description: row.row.title,
      confirmText: t["com.myoxus.database.row.delete"](),
      cancelText: t["Cancel"](),
      onCancel: () => restoreFocus(id),
      onConfirm: async () => {
        setSavingRowId(row.row.id);
        try {
          const result = await deleteRow(row);
          if (!result) restoreFocus(id);
        } catch {
          notify.error({
            title: t["com.myoxus.database.row.delete"](),
            message: t["com.myoxus.common.operation-failed"](),
            actions: [
              {
                label: t["com.myoxus.database.conflict.reload"](),
                onClick: async () => {
                  await onChanged();
                  restoreFocus(id);
                },
              },
            ],
          });
          restoreFocus(id);
        } finally {
          setSavingRowId(null);
        }
      },
    });
  };
  if (!projection.startField)
    return (
      <EmptyState
        title={t["com.myoxus.database.view.gantt"]()}
        description={t["com.myoxus.database.gantt.invalid-config"]()}
        cta={
          onConfigureFields ? (
            <Button onClick={onConfigureFields}>
              {t["com.myoxus.database.view.settings"]()}
            </Button>
          ) : undefined
        }
      />
    );
  const pendingRow = (id: string) => {
    const rowId = rowFor(id)?.row.id;
    return (
      savingRowId === rowId ||
      (savingTitle && rename?.row.row.id === rowId) ||
      (savingDependency &&
        [
          dependencyDraft?.intent.dependent.row.id,
          dependencyDraft?.intent.targetRow?.row.id,
        ].includes(rowId))
    );
  };
  const failed = () =>
    notify.error({
      title: t["Rename"](),
      message: t["com.myoxus.common.operation-failed"](),
      actions: [
        {
          label: t["com.myoxus.database.conflict.reload"](),
          onClick: () => onChanged(),
        },
      ],
    });
  return (
    <Stack ref={rootRef} tabIndex={-1}>
      {placing && !createChosen ? (
        <Alert>{t["com.myoxus.database.gantt.place-instruction"]()}</Alert>
      ) : null}
      <GanttView
        empty={false}
        markers={
          currentTime >= projection.axis.start &&
          currentTime <= projection.axis.end
            ? [
                {
                  id: "today",
                  value: currentTime,
                  label: t["com.myoxus.common.calendar.today"](),
                  move: { enabled: false },
                },
              ]
            : []
        }
        placement={{
          active: placing,
          enabled: canCreate && !creating,
          step:
            projection.startField.fieldType === DatabaseFieldKind.Date
              ? 86_400_000
              : projection.axis.step,
          draft: createDraft,
          onPreview: setCreateDraft,
          onChoose: () => {
            // Direct creation from the empty grid bypasses the toolbar's
            // beginPlace callback, but must capture the same guarded basis.
            createBasisRef.current ??= { record, view };
            setPlacing(true);
            setCreateChosen(true);
          },
          onCancel: cancelCreate,
          content: createChosen ? (
            <Group
              wrap="wrap"
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape" && !creating) cancelCreate();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void confirmCreate();
                }
              }}
            >
              {createRangeReadonly ? (
                <Alert>
                  {t["com.myoxus.database.temporal.projection-readonly"]()}
                </Alert>
              ) : null}
              <MyoxusTextInput
                autoFocus
                aria-label={t["Title"]()}
                value={createTitle}
                onChange={setCreateTitle}
                disabled={creating}
              />
              {groupField &&
              ![projection.startField.id, projection.endField?.id].includes(
                groupField.id,
              ) &&
              groupField.fieldType === DatabaseFieldKind.Date ? (
                <LocalizedDateInput
                  aria-label={groupField.name}
                  label={groupField.name}
                  value={groupDate}
                  onChange={setGroupDate}
                />
              ) : null}
              {groupField &&
              ![projection.startField.id, projection.endField?.id].includes(
                groupField.id,
              ) &&
              groupField.fieldType === DatabaseFieldKind.DateTime ? (
                <LocalizedDateTimeInput
                  aria-label={groupField.name}
                  label={groupField.name}
                  value={groupDate}
                  onChange={(value) =>
                    setGroupDate(
                      typeof value === "string"
                        ? new Date(value).toISOString()
                        : null,
                    )
                  }
                />
              ) : null}
              <Button
                disabled={
                  !canCreate ||
                  !createTitle.trim() ||
                  creating ||
                  createRangeReadonly
                }
                onClick={() => void confirmCreate()}
              >
                {t["com.myoxus.database.row.add"]()}
              </Button>
              <Button
                disabled={creating}
                variant="secondary"
                onClick={cancelCreate}
              >
                {t["Cancel"]()}
              </Button>
            </Group>
          ) : undefined,
        }}
        data-testid="database-gantt-view"
        axis={projection.axis}
        sections={projection.sections}
        onToggleSection={view.config.gantt?.group ? onToggleGroup : undefined}
        metadataColumns={metadataFields.map((field) => ({
          id: field.id,
          label: field.name,
        }))}
        retainMoveSource
        tasks={projection.tasks.map((task) => ({
          ...task,
          pending: pendingRow(task.id),
          move:
            savingRowId === rowFor(task.id)?.row.id
              ? { enabled: false }
              : task.move,
          resize:
            savingRowId === rowFor(task.id)?.row.id
              ? { enabled: false }
              : task.resize,
        }))}
        pinnedRows={projection.pinnedRows.map((task) => ({
          ...task,
          pending: pendingRow(task.id),
          labelAccessory: (
            <DatabasePresenceTarget
              rowId={rowFor(task.id)!.row.id}
              viewId={view.id}
            >
              <Group wrap="nowrap">
                {savingRowId === rowFor(task.id)?.row.id ? <Loading /> : null}
                <DatabaseRowActionMenu
                  record={record}
                  onChanged={onChanged}
                  canEdit={canEdit}
                  row={rowFor(task.id)!}
                  onDelete={canEdit ? () => requestDelete(task.id) : undefined}
                />
              </Group>
            </DatabasePresenceTarget>
          ),
          notice: projection.diagnosisByRowId.has(rowFor(task.id)!.row.id) ? (
            <Text size="xs">
              {t[
                diagnosticKeys[
                  projection.diagnosisByRowId.get(rowFor(task.id)!.row.id)!
                ]
              ]()}
            </Text>
          ) : undefined,
          metadata: Object.fromEntries(
            metadataFields.map((field) => [
              field.id,
              <DatabaseViewFieldValues
                key={field.id}
                databaseId={databaseId}
                fields={[field]}
                onChanged={onChanged}
                record={record}
                row={rowFor(task.id)!}
                rows={rows}
                readonly
                compact
              />,
            ]),
          ),
          labelContent:
            rename?.taskId === task.id ? (
              <MyoxusTextInput
                autoFocus
                aria-label={t["Title"]()}
                value={rename.value}
                disabled={savingTitle}
                readOnly={!canEdit}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onChange={(value) => setRename({ ...rename, value })}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    if (!savingTitle) closeRename();
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (savingTitle || !canEdit || !rename.value.trim()) return;
                    setSavingTitle(true);
                    void mutations
                      .rename(
                        rename.row,
                        rename.titleFieldId,
                        rename.value,
                        closeRename,
                      )
                      .then(closeRename)
                      .catch(() => {
                        closeRename();
                        failed();
                      })
                      .finally(() => setSavingTitle(false));
                  }
                }}
              />
            ) : undefined,
        }))}
        dependencies={[
          ...projection.dependencies.map((edge) => ({
            ...edge,
            selected: Boolean(
              selectedDependencyId &&
              projection.edgeById.get(edge.id)?.businessId ===
                projection.edgeById.get(selectedDependencyId)?.businessId,
            ),
          })),
          ...(dependencyDraft ? [dependencyDraft.preview] : []),
        ]}
        onBeginDependency={() => {
          if (projection.dependencyField)
            dependencyBasisRef.current = {
              rows: new Map(projection.rowByProjectionId),
              geometries: new Map(
                projection.dependencies.map((edge) => [edge.id, edge]),
              ),
              labels: new Map(
                [...projection.pinnedRows, ...projection.externalEndpoints].map(
                  (endpoint) => [endpoint.id, endpoint.label],
                ),
              ),
              edges: new Map(projection.edgeById),
              field: projection.dependencyField,
            };
        }}
        onCreateDependency={(sourceId, targetId) => {
          const basis = dependencyBasisRef.current;
          const source = basis?.rows.get(sourceId);
          const target =
            basis?.rows.get(targetId) ??
            projection.rowByProjectionId.get(targetId);
          if (basis && source && target)
            proposeDependency(
              basis.field,
              {
                kind: "create",
                dependent: target,
                prerequisiteId: source.row.id,
              },
              {
                id: "create-preview",
                fromTaskId: sourceId,
                toTaskId: targetId,
                kind: "connection",
              },
              sourceId,
              `${basis.labels.get(sourceId) ?? dependencyLabel(sourceId)} → ${basis.labels.get(targetId) ?? dependencyLabel(targetId)}`,
            );
        }}
        onReconnectDependency={(id, endpoint, targetId) => {
          const basis = dependencyBasisRef.current;
          const edge = basis?.edges.get(id);
          const target =
            basis?.rows.get(targetId) ??
            projection.rowByProjectionId.get(targetId);
          // Keep the opening edge when a reload removes its visible geometry.
          // Newly revealed targets capture their revision on explicit selection.
          const geometry = basis?.geometries.get(id);
          if (basis && edge && target && geometry)
            proposeDependency(
              basis.field,
              {
                kind: endpoint,
                dependent: edge.dependent,
                prerequisiteId: edge.prerequisiteId,
                targetRow: target,
              },
              {
                ...geometry,
                id: "reconnect-preview",
                ...(endpoint === "source"
                  ? { fromTaskId: targetId }
                  : { toTaskId: targetId }),
              },
              geometry.toTaskId,
              endpoint === "source"
                ? `${basis.labels.get(targetId) ?? dependencyLabel(targetId)} → ${basis.labels.get(geometry.toTaskId) ?? dependencyLabel(geometry.toTaskId)}`
                : `${basis.labels.get(geometry.fromTaskId) ?? dependencyLabel(geometry.fromTaskId)} → ${basis.labels.get(targetId) ?? dependencyLabel(targetId)}`,
            );
        }}
        onDeleteDependency={(id) => {
          const edge = projection.edgeById.get(id);
          const geometry = projection.dependencies.find(
            (edge) => edge.id === id,
          );
          if (projection.dependencyField && edge && geometry)
            proposeDependency(
              projection.dependencyField,
              {
                kind: "remove",
                dependent: edge.dependent,
                prerequisiteId: edge.prerequisiteId,
              },
              { ...geometry, id: "remove-preview" },
              geometry.toTaskId,
              `${dependencyLabel(geometry.fromTaskId)} → ${dependencyLabel(geometry.toTaskId)}`,
            );
        }}
        externalEndpoints={projection.externalEndpoints}
        showDependenciesWhenReadonly
        selectedDependencyId={selectedDependencyId}
        onSelectDependency={(id) => {
          setSelectedDependencyId(id);
          setSelectedRowId(null);
        }}
        onOpenExternalEndpoint={(id) => {
          const rowId = projection.externalRowById.get(id);
          if (rowId)
            detail?.openById?.(
              rowId,
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null,
            );
        }}
        readonly={!canEdit}
        taskActivation={{ enter: "open", doubleClick: "open" }}
        reorder={{ sections: { enabled: false }, tasks: { enabled: false } }}
        labels={{
          region: t["com.myoxus.database.view.gantt"](),
          row: t["Title"](),
          connectTask: t["com.myoxus.database.gantt.connect"](),
          deleteDependency: t["Delete"](),
          empty: t["com.myoxus.database.schedule.window-empty"](),
          reorderSection: t["com.myoxus.database.view.gantt"](),
          reorderTask: t["com.myoxus.database.view.gantt"](),
        }}
        onDeleteSelection={requestDelete}
        onSelectTask={(id) => {
          setSelectedDependencyId(null);
          setSelectedRowId(id ? (rowFor(id)?.row.id ?? null) : null);
          presence.updateFocus({
            rowId: id ? (rowFor(id)?.row.id ?? null) : null,
            fieldId: null,
            viewId: view.id,
          });
        }}
        onOpenTask={(id) => {
          const row = rowFor(id);
          if (row)
            detail?.open(
              row,
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null,
            );
        }}
        onRenameTask={(id) => {
          const row = rowFor(id);
          const titleFieldId = view.config.gantt?.titleFieldId;
          if (
            canEdit &&
            row &&
            titleFieldId &&
            !row.redacted &&
            !row.row.deletedAt
          )
            setRename({ taskId: id, row, titleFieldId, value: row.row.title });
        }}
        onBeginMove={(intent) => {
          const item = projection.intervalById.get(intent.taskId);
          const source = projection.tasks.find(
            (task) => task.id === intent.taskId,
          );
          if (item)
            presence.updateFocus({
              rowId: item.row.row.id,
              fieldId: projection.startField?.id,
              viewId: view.id,
              dragging: true,
            });
          if (item && source && projection.startField)
            moveBasisRef.current = {
              item,
              start: projection.startField,
              end: projection.endField,
              group: groupField ?? null,
              sourceKey: source.sectionId,
            };
        }}
        onCancelMove={() => {
          moveBasisRef.current = null;
          presence.updateFocus({
            dragging: false,
            rowId: selectedRowId,
            viewId: view.id,
          });
        }}
        onCommitMove={(intent) => {
          const basis = moveBasisRef.current;
          moveBasisRef.current = null;
          presence.updateFocus({
            dragging: false,
            rowId: basis?.item.row.row.id ?? null,
            viewId: view.id,
          });
          if (canEdit && basis) void commitMove(basis, intent);
        }}
      />
      {!loading &&
      !projection.tasks.length &&
      !projection.diagnostics.length ? (
        <EmptyState
          title={
            record.rowCount === 0
              ? t["com.myoxus.database.row.empty"]()
              : hasActiveQuery
                ? t["com.myoxus.db.member.no-results"]()
                : t["com.myoxus.database.schedule.window-empty"]()
          }
          description={
            hasActiveQuery
              ? t["com.myoxus.database.index.no-results-description"]()
              : record.rowCount === 0
                ? undefined
                : t["com.myoxus.database.schedule.window-empty-description"]()
          }
          cta={
            <Group>
              {canCreate ? (
                <Button onClick={beginPlace}>
                  {t["com.myoxus.database.row.add"]()}
                </Button>
              ) : null}
              {hasActiveQuery ? (
                <Button onClick={onClearQuery}>
                  {t["com.myoxus.database.view.clear-filters"]()}
                </Button>
              ) : (
                <Button onClick={onShowToday}>
                  {t["com.myoxus.common.calendar.today"]()}
                </Button>
              )}
              {onConfigureFields ? (
                <Button onClick={onConfigureFields}>
                  {t["com.myoxus.database.view.settings"]()}
                </Button>
              ) : null}
            </Group>
          }
        />
      ) : null}
      {dependencyDraft ? (
        <Modal
          open
          description={dependencyDraft.description}
          title={
            dependencyDraft.intent.kind === "remove"
              ? t["com.myoxus.database.gantt.remove-dependency"]()
              : t["com.myoxus.database.gantt.confirm-dependency"]()
          }
          onOpenChange={(open) => {
            if (!open && !savingDependency) closeDependency();
          }}
        >
          <Stack>
            <Group>
              <Button
                disabled={savingDependency || !canEdit}
                onClick={() => void confirmDependency()}
              >
                {t["Apply"]()}
              </Button>
              <Button
                variant="secondary"
                disabled={savingDependency}
                onClick={closeDependency}
              >
                {t["Cancel"]()}
              </Button>
            </Group>
          </Stack>
        </Modal>
      ) : null}
      {moveDateChoice ? (
        <Modal
          open
          onOpenChange={(open) => {
            if (!open && !savingRowId) {
              restoreFocus(moveDateChoice.intent.taskId);
              setMoveDateChoice(null);
            }
          }}
          title={t["com.myoxus.database.gantt.group-date-required"]()}
        >
          <Stack>
            {moveDateChoice.basis.group?.fieldType ===
            DatabaseFieldKind.Date ? (
              <LocalizedDateInput
                label={moveDateChoice.basis.group.name}
                value={moveGroupDate}
                onChange={setMoveGroupDate}
              />
            ) : (
              <LocalizedDateTimeInput
                label={moveDateChoice.basis.group?.name}
                value={moveGroupDate}
                onChange={(value) =>
                  setMoveGroupDate(
                    typeof value === "string"
                      ? new Date(value).toISOString()
                      : null,
                  )
                }
              />
            )}
            <Button
              disabled={!moveGroupDate || Boolean(savingRowId)}
              onClick={() =>
                void commitMove(
                  moveDateChoice.basis,
                  moveDateChoice.intent,
                  moveGroupDate ?? undefined,
                )
              }
            >
              {t["Apply"]()}
            </Button>
            <Button
              variant="secondary"
              disabled={Boolean(savingRowId)}
              onClick={() => {
                restoreFocus(moveDateChoice.intent.taskId);
                setMoveDateChoice(null);
              }}
            >
              {t["Cancel"]()}
            </Button>
          </Stack>
        </Modal>
      ) : null}
    </Stack>
  );
}
