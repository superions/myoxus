// SPDX-License-Identifier: AGPL-3.0-or-later

import { databaseManagedCapabilities } from "../managed";
import { useCreateRowFromTemplate } from "../row-templates/use-create-row-from-template";

import { useMutation } from "@myoxus/core/components/hooks/use-mutation";
import {
  bulkClearDatabaseCellValueMutation,
  bulkDeleteDatabaseRowsMutation,
  bulkRestoreDatabaseRowsMutation,
  bulkSetDatabaseCellValueMutation,
  clearDatabaseCellValueMutation,
  createDatabaseFieldMutation,
  createDatabaseRowMutation,
  DatabaseFieldKind,
  type DatabaseFieldKind as DatabaseFieldKindType,
  DatabaseSortDirection,
  type DatabaseSortRuleInput,
  deleteDatabaseFieldMutation,
  deleteDatabaseRowMutation,
  reorderDatabaseFieldsMutation,
  updateDatabaseCellValueMutation,
  updateDatabaseFieldMutation,
  updateDatabaseRowTitleMutation,
  updateDatabaseViewMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  TrashIcon,
} from "@myoxus/icons/react";
import {
  MenuItem,
  type MyoxusNotificationAction,
  MyoxusText,
  notify,
  Stack,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

import { DatabaseCellEditor } from "../cells";
import {
  createCellValueInput,
  createViewConfigInputFromEdits,
  defaultFieldConfigInput,
  getCellPrimitiveValue,
  getDatabaseCellEditRevision,
  getVisibleFieldIds,
  getVisibleFields,
  sortByPosition,
} from "../model";
import { useDatabaseConflictController } from "../presence";
import { DatabasePresenceTarget } from "../presence/database-presence-target";
import { executeRevisionMutation } from "../presence/execute-revision-mutation";
import { useDatabaseRowDetail } from "../row-detail";
import { defaultDatabaseRowTemplate } from "../row-templates";
import type { DatabaseChangeHandler } from "../shared";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseRowTemplateBinding,
  DatabaseView,
} from "../types";
import {
  DatabaseBulkEditModal,
  databaseBulkTagIntersection,
  isBulkEditableDatabaseField,
} from "./bulk-edit-modal";
import {
  databaseTableCellClipboardText,
  databaseTableParseClipboardValue,
  isDatabaseTableCellEditable,
} from "./clipboard";
import {
  databaseTableFieldDescriptors,
  databaseTableFieldTypeLabels,
  databaseTableLabels,
} from "./labels";
import {
  databaseTableRowDescriptors,
  databaseTableRowTemplateDescriptors,
} from "./rows";
import type { DatabaseTableRowDescriptor } from "./types";
import { DatabaseTableView as MyoxusDatabaseTableView } from "./view";

export function DatabaseTableView({
  databaseId,
  effectiveSort,
  onConfigureField,
  onExportCsvRows,
  record,
  rows,
  rowTemplates = [],
  view,
  onChanged,
  onOpenRowTemplateManagement,
  onUpdateSort,
  emptyRowsLabel,
}: {
  databaseId: string;
  effectiveSort: DatabaseSortRuleInput[];
  onConfigureField: (
    field: DatabaseField,
    trigger: HTMLButtonElement | null,
  ) => void;
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
  rowTemplates?: DatabaseRowTemplateBinding[];
  view: DatabaseView;
  onChanged: DatabaseChangeHandler;
  onOpenRowTemplateManagement?: () => void;
  onUpdateSort: (
    field: DatabaseField,
    descending: boolean | null,
  ) => Promise<void>;
  onExportCsvRows?: (rowIds: string[]) => Promise<void> | void;
  emptyRowsLabel?: string;
}) {
  const t = useI18n();
  const conflicts = useDatabaseConflictController();
  const rowDetail = useDatabaseRowDetail();
  const createField = useMutation({
    mutation: createDatabaseFieldMutation,
  });
  const createRow = useMutation({
    mutation: createDatabaseRowMutation,
  });
  const createRowFromTemplate = useCreateRowFromTemplate(
    record.database.workspaceId,
  );
  const updateView = useMutation({
    mutation: updateDatabaseViewMutation,
  });
  const updateField = useMutation({
    mutation: updateDatabaseFieldMutation,
  });
  const updateCell = useMutation({
    mutation: updateDatabaseCellValueMutation,
  });
  const clearCell = useMutation({
    mutation: clearDatabaseCellValueMutation,
  });
  const updateTitle = useMutation({
    mutation: updateDatabaseRowTitleMutation,
  });
  const deleteField = useMutation({
    mutation: deleteDatabaseFieldMutation,
  });
  const reorderFields = useMutation({
    mutation: reorderDatabaseFieldsMutation,
  });
  const deleteRow = useMutation({
    mutation: deleteDatabaseRowMutation,
  });
  const bulkDeleteRows = useMutation({
    mutation: bulkDeleteDatabaseRowsMutation,
  });
  const bulkRestoreRows = useMutation({
    mutation: bulkRestoreDatabaseRowsMutation,
  });
  const bulkSetCell = useMutation({
    mutation: bulkSetDatabaseCellValueMutation,
  });
  const bulkClearCell = useMutation({
    mutation: bulkClearDatabaseCellValueMutation,
  });
  const [bulkEditRows, setBulkEditRows] = useState<
    DatabaseTableRowDescriptor[] | null
  >(null);
  const fields = getVisibleFields(record, view);
  const fieldsById = useMemo(
    () => new Map(record.fields.map((field) => [field.id, field])),
    [record.fields],
  );
  const rowsById = useMemo(
    () => new Map(rows.map((row) => [row.row.id, row])),
    [rows],
  );
  const bulkEditRecords = useMemo(
    () =>
      (bulkEditRows ?? [])
        .map((row) => rows.find((candidate) => candidate.row.id === row.id))
        .filter((row): row is DatabaseRowRecord => Boolean(row)),
    [bulkEditRows, rows],
  );
  const initialBulkValueForField = useCallback(
    (field: DatabaseField) => {
      if (field.fieldType !== DatabaseFieldKind.Tags) {
        return null;
      }
      return databaseBulkTagIntersection(
        bulkEditRecords.map((row) => {
          const value = getCellPrimitiveValue(row, field);
          return Array.isArray(value) ? value.map(String) : [];
        }),
      );
    },
    [bulkEditRecords],
  );
  const orderedFieldIds = useMemo(
    () => sortByPosition(record.fields).map((field) => field.id),
    [record.fields],
  );
  const fieldWidths = useMemo(
    () => view.config.table?.fieldWidths ?? [],
    [view.config.table?.fieldWidths],
  );
  const defaultRowTemplate = useMemo(
    () => defaultDatabaseRowTemplate(rowTemplates),
    [rowTemplates],
  );
  const createDefaultRow = useCallback(async () => {
    if (defaultRowTemplate) {
      const response = await createRowFromTemplate.trigger({
        input: {
          databaseId,
          rowTemplateId: defaultRowTemplate.rowTemplate.id,
          title: t["com.myoxus.database.row.new-title"](),
        },
      });
      return response?.createDatabaseRowFromTemplate;
    }
    const response = await createRow.trigger({
      input: {
        databaseId,
        title: t["com.myoxus.database.row.new-title"](),
      },
    });
    return response?.createDatabaseRow;
  }, [createRow, createRowFromTemplate, databaseId, defaultRowTemplate, t]);

  const commitCellText = useCallback(
    async (
      row: DatabaseRowRecord,
      field: DatabaseField,
      text: string,
      refreshAfterSuccess = true,
    ) => {
      if (row.redacted || !isDatabaseTableCellEditable(field)) return;
      const refreshValue = () =>
        onChanged({
          kind:
            field.fieldType === DatabaseFieldKind.Title
              ? "row_updated"
              : "cell_updated",
          target: { fieldId: field.id, rowId: row.row.id },
        });
      if (field.fieldType === DatabaseFieldKind.Title) {
        const title = text.trim() || t["Untitled"]();
        await executeRevisionMutation(
          conflicts,
          updateTitle.trigger,
          {
            databaseId,
            rowId: row.row.id,
            title,
            titleFieldId: field.id,
            expectedEditRevision: row.row.editRevision,
          },
          {
            attemptedAction: field.name,
            localValue: title,
            reloadLatest: () => onChanged(),
            afterSuccess: refreshAfterSuccess ? refreshValue : undefined,
            afterForceSuccess: refreshAfterSuccess ? refreshValue : undefined,
          },
        );
        return;
      }
      if (!text.trim()) {
        await executeRevisionMutation(
          conflicts,
          clearCell.trigger,
          {
            databaseId,
            rowId: row.row.id,
            fieldId: field.id,
            expectedEditRevision: getDatabaseCellEditRevision(row, field.id),
          },
          {
            attemptedAction: field.name,
            localValue: null,
            reloadLatest: () => onChanged(),
            afterSuccess: refreshAfterSuccess ? refreshValue : undefined,
            afterForceSuccess: refreshAfterSuccess ? refreshValue : undefined,
          },
        );
        return;
      }
      const value = createCellValueInput(
        field,
        databaseTableParseClipboardValue(field, text),
      );
      await executeRevisionMutation(
        conflicts,
        updateCell.trigger,
        {
          databaseId,
          rowId: row.row.id,
          fieldId: field.id,
          value,
          expectedEditRevision: getDatabaseCellEditRevision(row, field.id),
        },
        {
          attemptedAction: field.name,
          localValue: text,
          reloadLatest: () => onChanged(),
          afterSuccess: refreshAfterSuccess ? refreshValue : undefined,
          afterForceSuccess: refreshAfterSuccess ? refreshValue : undefined,
        },
      );
    },
    [clearCell, conflicts, databaseId, onChanged, t, updateCell, updateTitle],
  );

  const pasteCells = useCallback(
    async ({
      start,
      values,
    }: {
      start: { fieldId: string; rowId: string };
      values: string[][];
    }) => {
      const startRowIndex = rows.findIndex((row) => row.row.id === start.rowId);
      const startFieldIndex = fields.findIndex(
        (field) => field.id === start.fieldId,
      );
      if (startRowIndex < 0 || startFieldIndex < 0) return;
      const workingRows = [...rows];
      let createdRow = false;
      for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
        while (startRowIndex + rowOffset >= workingRows.length) {
          const nextRow = await createDefaultRow();
          if (!nextRow) break;
          createdRow = true;
          workingRows.push(nextRow);
        }
        const targetRow = workingRows[startRowIndex + rowOffset];
        if (!targetRow) continue;
        const rowValues = values[rowOffset] ?? [];
        for (
          let fieldOffset = 0;
          fieldOffset < rowValues.length;
          fieldOffset += 1
        ) {
          const targetField = fields[startFieldIndex + fieldOffset];
          if (!targetField) continue;
          await commitCellText(
            targetRow,
            targetField,
            rowValues[fieldOffset]!,
            false,
          );
        }
      }
      await onChanged({
        kind: createdRow ? "row_created" : "cell_updated",
      });
    },
    [commitCellText, createDefaultRow, fields, onChanged, rows],
  );

  const fillCellWithValue = useCallback(
    async (row: DatabaseRowRecord, field: DatabaseField, value: string) => {
      if (!isDatabaseTableCellEditable(field)) return;
      await commitCellText(row, field, value);
    },
    [commitCellText],
  );

  const clearCells = useCallback(
    async ({ cells }: { cells: Array<{ fieldId: string; rowId: string }> }) => {
      for (const cell of cells) {
        const field = fieldsById.get(cell.fieldId);
        const row = rowsById.get(cell.rowId);
        if (!field || !row) continue;
        if (field.fieldType === DatabaseFieldKind.Title) {
          await executeRevisionMutation(
            conflicts,
            updateTitle.trigger,
            {
              databaseId,
              rowId: row.row.id,
              title: t["Untitled"](),
              titleFieldId: field.id,
              expectedEditRevision: row.row.editRevision,
            },
            {
              attemptedAction: field.name,
              localValue: t["Untitled"](),
              reloadLatest: () => onChanged(),
            },
          );
        } else {
          await executeRevisionMutation(
            conflicts,
            clearCell.trigger,
            {
              databaseId,
              rowId: row.row.id,
              fieldId: field.id,
              expectedEditRevision: getDatabaseCellEditRevision(row, field.id),
            },
            {
              attemptedAction: field.name,
              localValue: null,
              reloadLatest: () => onChanged(),
            },
          );
        }
      }
      await onChanged({ kind: "cell_updated" });
    },
    [
      clearCell,
      conflicts,
      databaseId,
      fieldsById,
      onChanged,
      rowsById,
      t,
      updateTitle,
    ],
  );

  const renameField = useCallback(
    async (field: DatabaseField, name: string) => {
      if (field.fieldType === DatabaseFieldKind.Title) return;
      const trimmed = name.trim();
      if (!trimmed || trimmed === field.name) return;
      await executeRevisionMutation(
        conflicts,
        updateField.trigger,
        {
          databaseId,
          fieldId: field.id,
          name: trimmed,
          expectedEditRevision: field.editRevision,
        },
        {
          attemptedAction: field.name,
          localValue: trimmed,
          reloadLatest: () => onChanged(),
          afterSuccess: () =>
            onChanged({
              kind: "field_updated",
              target: { fieldId: field.id },
            }),
        },
      );
    },
    [conflicts, databaseId, onChanged, updateField],
  );

  const reorderVisibleFields = useCallback(
    async (visibleFieldIds: string[]) => {
      const visibleSet = new Set(visibleFieldIds);
      const nextVisible = [...visibleFieldIds];
      const nextOrder = orderedFieldIds.map((fieldId) =>
        visibleSet.has(fieldId) ? nextVisible.shift()! : fieldId,
      );
      const nextViewVisibleFieldIds = visibleFieldIds.filter((fieldId) =>
        fieldsById.has(fieldId),
      );
      const currentViewVisibleFieldIds = getVisibleFieldIds(record, view);
      const schemaOrderUnchanged =
        nextOrder.length === orderedFieldIds.length &&
        nextOrder.every((fieldId, index) => fieldId === orderedFieldIds[index]);
      const viewOrderUnchanged =
        nextViewVisibleFieldIds.length === currentViewVisibleFieldIds.length &&
        nextViewVisibleFieldIds.every(
          (fieldId, index) => fieldId === currentViewVisibleFieldIds[index],
        );
      if (schemaOrderUnchanged && viewOrderUnchanged) {
        return;
      }
      if (!viewOrderUnchanged) {
        const config = createViewConfigInputFromEdits(record, view, {
          visibleFieldIds: nextViewVisibleFieldIds,
        });
        await executeRevisionMutation(
          conflicts,
          updateView.trigger,
          {
            databaseId,
            viewId: view.id,
            name: view.name,
            config,
            expectedEditRevision: view.editRevision,
          },
          {
            attemptedAction: t["com.myoxus.database.view.settings"](),
            localValue: config,
            reloadLatest: () => onChanged(),
          },
        );
      }
      if (!schemaOrderUnchanged) {
        await executeRevisionMutation(
          conflicts,
          reorderFields.trigger,
          {
            databaseId,
            fieldIds: nextOrder,
            expectedEditRevisions: record.fields.map((item) => ({
              fieldId: item.id,
              expectedEditRevision: item.editRevision,
            })),
          },
          {
            attemptedAction: t["com.myoxus.database.field.reorder"](),
            localValue: nextOrder,
            reloadLatest: () => onChanged(),
          },
        );
      }
      await onChanged({
        kind:
          !viewOrderUnchanged && !schemaOrderUnchanged
            ? "structure_updated"
            : !viewOrderUnchanged
              ? "view_updated"
              : "field_reordered",
        target: { viewId: view.id },
      });
    },
    [
      databaseId,
      conflicts,
      fieldsById,
      onChanged,
      orderedFieldIds,
      record,
      reorderFields,
      updateView,
      t,
      view,
    ],
  );

  const resizeField = useCallback(
    async (field: DatabaseField, width: number) => {
      const nextFieldWidths = [
        ...fieldWidths.filter((fieldWidth) => fieldWidth.fieldId !== field.id),
        { fieldId: field.id, width },
      ];
      const config = createViewConfigInputFromEdits(record, view, {
        fieldWidths: nextFieldWidths,
      });
      await executeRevisionMutation(
        conflicts,
        updateView.trigger,
        {
          databaseId,
          viewId: view.id,
          name: view.name,
          config,
          expectedEditRevision: view.editRevision,
        },
        {
          attemptedAction: t["com.myoxus.database.view.settings"](),
          localValue: config,
          reloadLatest: () => onChanged(),
          afterSuccess: () =>
            onChanged({
              kind: "view_updated",
              target: { viewId: view.id },
            }),
        },
      );
    },
    [
      conflicts,
      databaseId,
      fieldWidths,
      onChanged,
      record,
      t,
      updateView,
      view,
    ],
  );

  const notifyBulkResult = useCallback(
    (
      result: {
        failureCount: number;
        successCount: number;
        total: number;
        transactionCommitted: boolean;
      },
      actions?: MyoxusNotificationAction[],
    ) => {
      if (!result.transactionCommitted) {
        notify.warning({
          title: t["com.myoxus.database.bulk.result.cancelled"](),
        });
        return;
      }
      if (result.failureCount > 0 && result.successCount > 0) {
        notify.warning({
          title: t["com.myoxus.database.bulk.result.partial"]({
            failed: String(result.failureCount),
            success: String(result.successCount),
            total: String(result.total),
          }),
        });
        return;
      }
      if (result.failureCount > 0) {
        notify.error({
          title: t["com.myoxus.database.bulk.result.failedOnly"]({
            failed: String(result.failureCount),
          }),
        });
        return;
      }
      notify.success(
        {
          title: t["com.myoxus.database.bulk.result.success"]({
            count: String(result.successCount),
          }),
          actions,
        },
        actions?.length ? { duration: 15_000 } : undefined,
      );
    },
    [t],
  );

  return (
    <Stack gap="xs">
      <MyoxusDatabaseTableView
        canEditStructure={databaseManagedCapabilities(record).canEditStructure}
        canResizeFields={databaseManagedCapabilities(record).canEditStructure}
        labels={databaseTableLabels(t, emptyRowsLabel)}
        fieldTypeLabels={databaseTableFieldTypeLabels(t)}
        fields={databaseTableFieldDescriptors(fields, fieldWidths, t).map(
          (descriptor) => {
            const sortIndex = effectiveSort.findIndex(
              (rule) => rule.fieldId === descriptor.id,
            );
            const sortRule = sortIndex >= 0 ? effectiveSort[sortIndex] : null;
            return {
              ...descriptor,
              sortDirection:
                sortRule?.direction === DatabaseSortDirection.Asc
                  ? ("asc" as const)
                  : sortRule?.direction === DatabaseSortDirection.Desc
                    ? ("desc" as const)
                    : null,
              sortPriority: sortRule ? sortIndex + 1 : null,
            };
          },
        )}
        rows={databaseTableRowDescriptors(rows)}
        rowTemplates={databaseTableRowTemplateDescriptors(rowTemplates)}
        onCreateField={async ({ name, kind }) => {
          const fieldType = kind as DatabaseFieldKindType;
          const response = await createField.trigger({
            input: {
              databaseId,
              name,
              fieldType,
              config: defaultFieldConfigInput(fieldType),
            },
          });
          const createdField = response?.createDatabaseField;
          if (createdField) {
            const visibleFieldIds = getVisibleFieldIds(record, view);
            if (!visibleFieldIds.includes(createdField.id)) {
              const config = createViewConfigInputFromEdits(
                { ...record, fields: [...record.fields, createdField] },
                view,
                { visibleFieldIds: [...visibleFieldIds, createdField.id] },
              );
              await executeRevisionMutation(
                conflicts,
                updateView.trigger,
                {
                  databaseId,
                  viewId: view.id,
                  name: view.name,
                  config,
                  expectedEditRevision: view.editRevision,
                },
                {
                  attemptedAction: t["com.myoxus.database.view.settings"](),
                  localValue: config,
                  reloadLatest: () => onChanged(),
                },
              );
            }
          }
          await onChanged({
            kind: createdField ? "structure_updated" : "field_created",
            target: { fieldId: createdField?.id, viewId: view.id },
          });
        }}
        onCreateRow={async () => {
          const created = await createDefaultRow();
          if (!created) return;
          await onChanged({
            kind: "row_created",
            target: { rowId: created?.row.id },
          });
        }}
        onCreateRowFromTemplate={async (rowTemplateId) => {
          const response = await createRowFromTemplate.trigger({
            input: { databaseId, rowTemplateId },
          });
          if (!response) return;
          await onChanged({
            kind: "row_created",
            target: {
              rowId: response?.createDatabaseRowFromTemplate?.row.id,
            },
          });
        }}
        onDeleteField={async (field) => {
          const source = fieldsById.get(field.id);
          if (!source) return;
          await executeRevisionMutation(
            conflicts,
            deleteField.trigger,
            {
              databaseId,
              fieldId: field.id,
              expectedEditRevision: source.editRevision,
            },
            {
              attemptedAction: t["com.myoxus.database.field.delete"](),
              localValue: source.name,
              reloadLatest: () => onChanged(),
              afterSuccess: () =>
                onChanged({
                  kind: "field_deleted",
                  target: { fieldId: field.id },
                }),
            },
          );
        }}
        onDeleteRow={async (row) => {
          const source = rowsById.get(row.id);
          if (!source) return;
          await executeRevisionMutation(
            conflicts,
            deleteRow.trigger,
            {
              databaseId,
              rowId: row.id,
              expectedEditRevision: source.row.editRevision,
            },
            {
              attemptedAction: t["Delete"](),
              localValue: source.row.title,
              reloadLatest: () => onChanged(),
              afterSuccess: () =>
                onChanged({
                  kind: "row_deleted",
                  target: { rowId: row.id },
                }),
            },
          );
        }}
        onBulkDeleteRows={async (selectedRows) => {
          if (!selectedRows.length) return;
          const selectedRecords = selectedRows
            .map((row) => rowsById.get(row.id))
            .filter((row): row is DatabaseRowRecord => Boolean(row));
          const response = await executeRevisionMutation(
            conflicts,
            bulkDeleteRows.trigger,
            {
              databaseId,
              rowIds: selectedRecords.map((row) => row.row.id),
              expectedEditRevisions: selectedRecords.map((row) => ({
                rowId: row.row.id,
                expectedEditRevision: row.row.editRevision,
              })),
            },
            {
              attemptedAction: t["Delete"](),
              localValue: selectedRecords.map((row) => row.row.title),
              reloadLatest: () => onChanged(),
            },
          );
          const result = response?.bulkDeleteDatabaseRows;
          if (result) {
            const restoreAction =
              result.transactionCommitted && result.successCount > 0
                ? [
                    {
                      key: "database-bulk-restore",
                      label: t["com.myoxus.database.bulk.action.restore"](),
                      onClick: async () => {
                        const restoreResponse = await executeRevisionMutation(
                          conflicts,
                          bulkRestoreRows.trigger,
                          {
                            databaseId,
                            rowIds: selectedRecords.map((row) => row.row.id),
                          },
                          {
                            attemptedAction:
                              t["com.myoxus.database.bulk.action.restore"](),
                            localValue: selectedRecords.map(
                              (row) => row.row.title,
                            ),
                            reloadLatest: () => onChanged(),
                          },
                        );
                        const restoreResult =
                          restoreResponse?.bulkRestoreDatabaseRows;
                        if (restoreResult) notifyBulkResult(restoreResult);
                        await onChanged({ kind: "row_restored" });
                      },
                    },
                  ]
                : undefined;
            notifyBulkResult(result, restoreAction);
          }
          await onChanged({ kind: "row_deleted" });
        }}
        onBulkEditRows={
          fields.some(isBulkEditableDatabaseField) ? setBulkEditRows : undefined
        }
        onBulkExportRows={
          onExportCsvRows
            ? (selectedRows) =>
                onExportCsvRows(selectedRows.map((row) => row.id))
            : undefined
        }
        onFieldRename={async (field, name) => {
          const original = fieldsById.get(field.id);
          if (original) await renameField(original, name);
        }}
        onFieldReorder={async (field, direction) => {
          const original = fieldsById.get(field.id);
          if (!original) return;
          const orderedIds = orderedFieldIds;
          const position = orderedIds.indexOf(field.id);
          const target = position + direction;
          if (target < 0 || target >= orderedIds.length) return;
          const swapWith = orderedIds[target];
          if (!swapWith) return;
          // Build the new schema order: keep all IDs but swap `original` and
          // `swapWith`. Then hand it to `reorderVisibleFields` so the host
          // can issue both the schema and the view-visible updates.
          const newOrder = [...orderedIds];
          newOrder[position] = swapWith;
          newOrder[target] = original.id;
          await reorderVisibleFields(newOrder);
        }}
        onFieldResize={async (field, width) => {
          const original = fieldsById.get(field.id);
          if (original) await resizeField(original, width);
        }}
        onOpenRowDetails={(row) => {
          const record = rowsById.get(row.id);
          if (record) rowDetail?.open(record);
        }}
        onChangeTitle={async (rowId, value) => {
          const original = rowsById.get(rowId);
          const titleFieldOriginal = record.fields.find(
            (field) => field.fieldType === DatabaseFieldKind.Title,
          );
          if (!original || !titleFieldOriginal) return;
          await commitCellText(original, titleFieldOriginal, value);
        }}
        onPasteCells={(row, field, value) =>
          pasteCells({
            start: { fieldId: field.id, rowId: row.id },
            values: [[value]],
          })
        }
        onPasteCellsRange={({ start, values }) =>
          pasteCells({
            start: { fieldId: start.field.id, rowId: start.row.id },
            values,
          })
        }
        onFillCells={(row, field, value) => {
          const originalField = fieldsById.get(field.id);
          const originalRow = rowsById.get(row.id);
          if (!originalField || !originalRow) return Promise.resolve();
          return fillCellWithValue(originalRow, originalField, value);
        }}
        getCellClipboardText={(row, field) => {
          const originalField = fieldsById.get(field.id);
          const originalRow = rowsById.get(row.id);
          if (!originalField || !originalRow) return row.title ?? "";
          return databaseTableCellClipboardText(
            originalRow,
            originalField,
            t.language,
            { checkboxTrue: t["com.myoxus.database.cell.checked"]() },
          );
        }}
        onClearCells={(cells) =>
          clearCells({
            cells: cells.map((cell) => ({
              rowId: cell.row.id,
              fieldId: cell.field.id,
            })),
          })
        }
        onRequestFieldConfiguration={(field, trigger) => {
          const original = fieldsById.get(field.id);
          if (original) onConfigureField(original, trigger);
        }}
        renderFieldMenuItems={({ field }) => {
          const original = fieldsById.get(field.id);
          if (!original) return null;
          const activeSort = effectiveSort.find(
            (rule) => rule.fieldId === field.id,
          );
          return (
            <>
              <MenuItem
                prefix={<ArrowUpSmallIcon />}
                onSelect={() => void onUpdateSort(original, false)}
              >
                {t["com.myoxus.database.view.sort-ascending"]()}
              </MenuItem>
              <MenuItem
                prefix={<ArrowDownSmallIcon />}
                onSelect={() => void onUpdateSort(original, true)}
              >
                {t["com.myoxus.database.view.sort-descending"]()}
              </MenuItem>
              {activeSort ? (
                <MenuItem
                  prefix={<TrashIcon />}
                  onSelect={() => void onUpdateSort(original, null)}
                >
                  {t["com.myoxus.database.view.no-sort"]()}
                </MenuItem>
              ) : null}
            </>
          );
        }}
        onRequestRowTemplateManagement={onOpenRowTemplateManagement}
        renderCell={({ field, row }) => {
          const originalField = fieldsById.get(field.id);
          const originalRow = rowsById.get(row.id);
          if (!originalField || !originalRow) {
            return <MyoxusText tone="secondary">{field.label}</MyoxusText>;
          }
          return (
            <DatabasePresenceTarget
              fieldId={originalField.id}
              rowId={originalRow.row.id}
              viewId={view.id}
            >
              <DatabaseCellEditor
                databaseId={databaseId}
                field={originalField}
                record={record}
                row={originalRow}
                rows={rows}
                onChanged={onChanged}
              />
            </DatabasePresenceTarget>
          );
        }}
      />
      <DatabaseBulkEditModal
        fields={fields}
        open={Boolean(bulkEditRows)}
        pending={bulkSetCell.isMutating || bulkClearCell.isMutating}
        selectedCount={bulkEditRows?.length ?? 0}
        initialValueForField={initialBulkValueForField}
        onOpenChange={(open) => {
          if (!open) setBulkEditRows(null);
        }}
        onApply={async (field, value) => {
          const selectedRecords = (bulkEditRows ?? [])
            .map((row) => rowsById.get(row.id))
            .filter((row): row is DatabaseRowRecord => Boolean(row));
          if (!selectedRecords.length) return false;
          const response = await executeRevisionMutation(
            conflicts,
            bulkSetCell.trigger,
            {
              databaseId,
              fieldId: field.id,
              rows: selectedRecords.map((row) => ({
                rowId: row.row.id,
                expectedEditRevision: getDatabaseCellEditRevision(
                  row,
                  field.id,
                ),
                value: createCellValueInput(field, value),
              })),
            },
            {
              attemptedAction: t["com.myoxus.database.bulk.action.edit"](),
              localValue: value,
              reloadLatest: () => onChanged(),
            },
          );
          const result = response?.bulkSetDatabaseCellValue;
          if (result) notifyBulkResult(result);
          await onChanged({ kind: "cell_updated" });
          return Boolean(result?.transactionCommitted);
        }}
        onClear={async (field) => {
          const selectedRecords = (bulkEditRows ?? [])
            .map((row) => rowsById.get(row.id))
            .filter((row): row is DatabaseRowRecord => Boolean(row));
          if (!selectedRecords.length) return false;
          const response = await executeRevisionMutation(
            conflicts,
            bulkClearCell.trigger,
            {
              databaseId,
              fieldId: field.id,
              rowIds: selectedRecords.map((row) => row.row.id),
              expectedEditRevisions: selectedRecords.map((row) => ({
                rowId: row.row.id,
                expectedEditRevision: getDatabaseCellEditRevision(
                  row,
                  field.id,
                ),
              })),
            },
            {
              attemptedAction: t["com.myoxus.database.bulk.action.clear"](),
              localValue: null,
              reloadLatest: () => onChanged(),
            },
          );
          const result = response?.bulkClearDatabaseCellValue;
          if (result) notifyBulkResult(result);
          await onChanged({ kind: "cell_updated" });
          return Boolean(result?.transactionCommitted);
        }}
      />
    </Stack>
  );
}
