// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import {
  createDatabaseRowMutation,
  DatabaseCardDensity,
  DatabaseFieldKind,
  DatabaseProfileKind,
  DatabaseViewKind,
  updateDatabaseCellValueMutation,
  updateDatabaseRowPositionMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { MoreHorizontalIcon, SettingsIcon } from "@myoxus/icons/react";
import {
  Button,
  EmptyState,
  IconButton,
  KanbanBoard,
  type KanbanBoardLabels,
  type KanbanBoardProps,
  type KanbanCardMove,
  type KanbanColumnModel,
  Menu,
  MenuItem,
  Notice,
  notify,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  createCellValueInput,
  databaseRowDropPosition,
  getCellPrimitiveValue,
  getDatabaseCellEditRevision,
  getFieldById,
  getSelectOptions,
  getTitleField,
  getVisibleFields,
  sortDatabaseRowsByPosition,
} from "../model";
import { useDatabaseConflictController } from "../presence";
import { executeRevisionMutation } from "../presence/execute-revision-mutation";
import { useDatabaseRowDetail } from "../row-detail";
import { defaultDatabaseRowTemplate } from "../row-templates";
import { useCreateRowFromTemplate } from "../row-templates/use-create-row-from-template";
import type { DatabaseChangeHandler } from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseRowTemplateBinding,
  DatabaseView,
} from "../types";
import { getKanbanGroupField } from "../view-controls";
import { databaseViewKindLabel } from "../view-controls/labels";
import { useDatabaseKanbanCardContent } from "./card-content";
export { DatabaseKanbanProperty } from "./property";

export function isKanbanPositionSurrogateField(field: DatabaseField) {
  return (
    field.fieldType === DatabaseFieldKind.Number &&
    field.name.trim().toLowerCase() === "score"
  );
}

function DatabaseKanbanGroupActions({
  name,
  field,
  onConfigure,
}: {
  name: string;
  field: DatabaseField;
  onConfigure: (field: DatabaseField, trigger: HTMLElement | null) => void;
}) {
  const t = useI18n();
  const detail = useDatabaseRowDetail();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Menu
      items={
        <MenuItem
          prefix={<SettingsIcon />}
          disabled={!detail?.canEdit}
          onSelect={() => onConfigure(field, triggerRef.current)}
        >
          {t["com.myoxus.page.display.grouping"]()}
        </MenuItem>
      }
    >
      <IconButton
        ref={triggerRef}
        aria-label={`${name}: ${t["com.myoxus.database.row.menu"]()}`}
        tooltip={`${name}: ${t["com.myoxus.database.row.menu"]()}`}
        icon={<MoreHorizontalIcon />}
        data-testid="database-kanban-column-menu"
      />
    </Menu>
  );
}

export function DatabaseKanbanView({
  databaseId,
  onConfigure,
  record,
  rows,
  rowTemplates = [],
  view,
  onChanged,
  onConfigureGroupField,
}: {
  databaseId: string;
  onConfigure?: () => void;
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
  rowTemplates?: DatabaseRowTemplateBinding[];
  view: DatabaseView;
  onChanged: DatabaseChangeHandler;
  onConfigureGroupField?: (
    field: DatabaseField,
    trigger: HTMLElement | null,
  ) => void;
}) {
  const t = useI18n();
  const detail = useDatabaseRowDetail();
  const conflicts = useDatabaseConflictController();
  const [focusRequest, setFocusRequest] =
    useState<KanbanBoardProps["focusRequest"]>();
  const updateCell = useMutation({ mutation: updateDatabaseCellValueMutation });
  const updateRowPosition = useMutation({
    mutation: updateDatabaseRowPositionMutation,
  });
  const createRow = useMutation({ mutation: createDatabaseRowMutation });
  const createRowFromTemplate = useCreateRowFromTemplate(
    record.database.workspaceId,
  );
  const groupField = getKanbanGroupField(record, view);
  const titleField = getTitleField(record);
  const visibleFields = getVisibleFields(record, view).filter(
    (field) =>
      field.id !== titleField.id &&
      field.id !== groupField?.id &&
      !isKanbanPositionSurrogateField(field),
  );
  const coverFieldId = view.config.kanban?.coverFieldId;
  const cardContent = useDatabaseKanbanCardContent({
    databaseId,
    onChanged,
    record,
    rows,
    visibleFields,
    viewId: view.id,
    coverField: coverFieldId ? getFieldById(record, coverFieldId) : null,
    workspaceId: record.database.workspaceId,
  });
  const defaultTemplate = useMemo(
    () => defaultDatabaseRowTemplate(rowTemplates),
    [rowTemplates],
  );
  const groups = groupField ? getSelectOptions(groupField) : [];
  const visibleRows = useMemo(
    () =>
      record.database.profileKind === DatabaseProfileKind.Project
        ? rows.filter((row) => row.row.rowKind === "task")
        : rows,
    [record.database.profileKind, rows],
  );
  const rowsByGroup = new Map<string, DatabaseRowRecord[]>(
    groups.map((group) => [group.id, []]),
  );
  rowsByGroup.set("", []);
  if (groupField)
    for (const row of visibleRows) {
      const groupId = String(getCellPrimitiveValue(row, groupField) ?? "");
      (rowsByGroup.get(groupId) ?? rowsByGroup.get(""))!.push(row);
    }
  const visibleGroups = [
    ...groups,
    ...(record.database.profileKind !== DatabaseProfileKind.Project ||
    rowsByGroup.get("")!.length
      ? [{ id: "", name: t["com.myoxus.database.kanban.unassigned"]() }]
      : []),
  ];
  // Prefix every native option, including the empty Cell value, without
  // reserving an option ID that a Generic Database might legitimately use.
  const columnId = (id: string) => `group:${id}`;
  const nativeGroupId = (id: string) => id.slice("group:".length);
  const columns: KanbanColumnModel[] = visibleGroups.map((group) => ({
    id: columnId(group.id),
    label: group.name,
    receive: { enabled: Boolean(detail?.canEdit) },
    add: { enabled: Boolean(detail?.canEdit) },
    rename: { enabled: false },
    reorder: { enabled: false },
    remove: { enabled: false },
    testId: "database-kanban-column",
    frameTestId: "database-kanban-column-frame",
    addCardTestId: rowsByGroup.get(group.id)?.length
      ? "database-kanban-column-new"
      : "database-kanban-empty-cta",
    actions: onConfigureGroupField ? (
      <DatabaseKanbanGroupActions
        name={group.name}
        field={groupField!}
        onConfigure={onConfigureGroupField}
      />
    ) : undefined,
    cards: sortDatabaseRowsByPosition(rowsByGroup.get(group.id) ?? []).map(
      (row) => ({
        ...cardContent(row),
        id: row.row.id,
        columnId: columnId(group.id),
        label: row.row.title,
        description: `${row.row.title}: ${t["com.myoxus.database.row.open-details"]()}`,
        defaultActions: false,
        open: { enabled: Boolean(detail) },
        move: {
          enabled: Boolean(
            detail?.canEdit && !row.redacted && !row.row.deletedAt,
          ),
        },
        rename: { enabled: false },
        remove: { enabled: false },
        density:
          view.config.kanban?.cardDensity === DatabaseCardDensity.Compact
            ? "compact"
            : view.config.kanban?.cardDensity ===
                DatabaseCardDensity.Comfortable
              ? "card"
              : "default",
        testId: "database-kanban-card",
        dataAttributes: { "data-row-id": row.row.id },
      }),
    ),
  }));
  const moveCard = useCallback(
    async (move: KanbanCardMove) => {
      if (!groupField || !detail?.canEdit) return false;
      const sourceRow = rows.find((row) => row.row.id === move.cardId);
      if (!sourceRow) return false;
      const targetGroupId = nativeGroupId(move.toColumnId);
      const sourceGroupId = String(
        getCellPrimitiveValue(sourceRow, groupField) ?? "",
      );
      const targetRows = sortDatabaseRowsByPosition(
        visibleRows.filter(
          (row) =>
            row.row.id !== move.cardId &&
            String(getCellPrimitiveValue(row, groupField) ?? "") ===
              targetGroupId,
        ),
      );
      const targetPosition = databaseRowDropPosition(
        visibleRows,
        move.cardId,
        move.targetCardId ?? targetRows.at(-1)?.row.id,
        move.edge === "before" ? "top" : "bottom",
      );
      let acknowledged = false;
      try {
        if (sourceGroupId !== targetGroupId) {
          const result = await executeRevisionMutation(
            conflicts,
            updateCell.trigger,
            {
              databaseId,
              rowId: move.cardId,
              fieldId: groupField.id,
              value: createCellValueInput(groupField, targetGroupId),
              expectedEditRevision: getDatabaseCellEditRevision(
                sourceRow,
                groupField.id,
              ),
            },
            {
              attemptedAction: groupField.name,
              localValue: targetGroupId,
              reloadLatest: () => onChanged(),
            },
          );
          if (!result) return false;
          acknowledged = true;
        }
        const result = await executeRevisionMutation(
          conflicts,
          updateRowPosition.trigger,
          {
            databaseId,
            rowId: move.cardId,
            position: targetPosition,
            expectedEditRevision: sourceRow.row.editRevision,
          },
          {
            attemptedAction: t["com.myoxus.database.kanban.drag-row"](),
            localValue: targetPosition,
            reloadLatest: () => onChanged(),
          },
        );
        if (!result) {
          if (acknowledged) await onChanged();
          return false;
        }
        await onChanged({ kind: "row_moved", target: { rowId: move.cardId } });
        return true;
      } catch {
        notify.error({ title: t["com.myoxus.database.kanban.move-failed"]() });
        // A partial group/rank write is not an accepted complete move.
        if (acknowledged) void onChanged();
        return false;
      }
    },
    [
      conflicts,
      databaseId,
      detail?.canEdit,
      groupField,
      onChanged,
      rows,
      t,
      updateCell,
      updateRowPosition,
      visibleRows,
    ],
  );
  const createTaskInGroup = useCallback(
    async (targetColumnId: string) => {
      if (!groupField || !detail?.canEdit) return;
      const cells = [
        {
          fieldId: groupField.id,
          value: createCellValueInput(
            groupField,
            nativeGroupId(targetColumnId),
          ),
        },
      ];
      try {
        const rowTemplateId = defaultTemplate?.rowTemplate.id;
        let createdRowId: string | undefined;
        if (rowTemplateId) {
          const response = await createRowFromTemplate.trigger({
            input: {
              databaseId,
              rowTemplateId,
              title: t["com.myoxus.database.row.new-title"](),
              overrideCellValues: cells,
            },
          });
          createdRowId = response?.createDatabaseRowFromTemplate.row.id;
        } else {
          const response = await createRow.trigger({
            input: {
              databaseId,
              title: t["com.myoxus.database.row.new-title"](),
              cells,
            },
          });
          createdRowId = response?.createDatabaseRow.row.id;
        }
        if (!createdRowId) return;
        await onChanged({
          kind: "row_created",
          target: { rowId: createdRowId },
        });
        setFocusRequest((previous) => ({
          requestId: (previous?.requestId ?? 0) + 1,
          selection: { cardId: createdRowId },
          target: "card-title",
        }));
      } catch {
        notify.error({
          title: t["com.myoxus.database.kanban.permission-denied"](),
        });
      }
    },
    [
      createRow,
      createRowFromTemplate,
      databaseId,
      defaultTemplate,
      detail?.canEdit,
      groupField,
      onChanged,
      t,
    ],
  );
  const labels: KanbanBoardLabels = {
    actions: t["com.myoxus.database.row.menu"](),
    addCard: (column) =>
      t["com.myoxus.database.kanban.add-task-to-column"]({ column }),
    addCardText: t["com.myoxus.database.kanban.add-task"](),
    addColumn: t["com.myoxus.database.kanban.add-column"](),
    cardCount: String,
    dragCard: () => t["com.myoxus.database.kanban.drag-row"](),
    dragColumn: (label) => label,
    deleteCard: (label) => label,
    deleteColumn: (label) => label,
    emptyColumn: "",
    openCard: () => t["com.myoxus.database.row.open-details"](),
    movedCard: (label, _from, to) => `${label}: ${to}`,
    movedColumn: (label, to) => `${label}: ${to}`,
  };
  if (!groupField)
    return (
      <EmptyState
        title={t["com.myoxus.database.kanban.invalid-title"]()}
        description={t["com.myoxus.database.kanban.invalid-description"]()}
        cta={
          onConfigure ? (
            <Button
              prefix={<SettingsIcon />}
              onClick={onConfigure}
              data-testid="database-kanban-configure"
            >
              {t["com.myoxus.database.view.settings"]()}
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <Stack gap="md" miw={0} data-testid="database-kanban-view-root">
      {!detail?.canEdit ? (
        <Notice
          tone="info"
          data-testid="database-kanban-read-only-notice"
          data-myoxus-ui-role="database-kanban-read-only-notice"
        >
          {t["com.myoxus.database.kanban.permission-denied"]()}
        </Notice>
      ) : null}
      <KanbanBoard
        key={`${databaseId}:${view.id}:${groupField.id}`}
        aria-label={databaseViewKindLabel(t, DatabaseViewKind.Kanban)}
        data-testid="database-kanban-view"
        appearance="surface"
        activation="open"
        order="manual"
        keyboardMovement="adjacent-column"
        columns={columns}
        labels={labels}
        readonly={!detail?.canEdit}
        focusRequest={focusRequest}
        onOpenCard={(id, trigger) => {
          const row = rows.find((row) => row.row.id === id);
          if (row) detail?.open(row, trigger);
        }}
        onMoveCard={moveCard}
        onAddCard={createTaskInGroup}
        onAddColumn={
          onConfigureGroupField && detail?.canEdit
            ? (trigger) => onConfigureGroupField(groupField, trigger)
            : undefined
        }
      />
    </Stack>
  );
}
