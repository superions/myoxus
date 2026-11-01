// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Myoxus-owned active Database Table view (P-DB-29B-B).
//
// This component replaces the legacy preset element that
// the Database view host rendered before. It is a plain
// Mantine/Facade-backed table surface; it must never import
// any legacy data-view preset module and never accept editor-local
// block model types.
//
// The component is deliberately a thin orchestrator: the heavy lifting
// (clipboard, paste parsing, label translation, template descriptors,
// editability) is in the sibling helpers under `./labels.ts`,
// `./rows.ts` and `./clipboard.ts`. The component consumes those
// helpers and emits the same callback contract the host already
// expects (`onCreateField`, `onCreateRow`, `onFieldReorder`, ...).
//
// Scope of this slice:
//   * field + header row with a `+ New field` plus button placed after
//     the final visible field (per P-DB-29B-B layout requirement);
//   * row plus button rendered as the stable `New row` row at the end
//     of the visible row set;
//   * row click + doc open;
//   * row delete + field delete via the Facade Menu primitive;
//   * field reorder, field resize, field rename, fill and paste
//     wired through the same callbacks the legacy preset received.

import { DatabaseFieldKind } from "@myoxus/graphql";
import { MoreHorizontalIcon, PlusIcon } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  IconButton,
  InlineEdit,
  Input,
  Menu,
  MenuItem,
  Modal,
  MyoxusText,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
  useResponsiveSmQuery,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DatabaseTableFieldDescriptor,
  DatabaseTableFieldTypeLabels,
  DatabaseTableLabels,
  DatabaseTableRowDescriptor,
  DatabaseTableRowTemplateDescriptor,
} from "./types";

/** Cell-level render function the host passes in. */
export type DatabaseTableCellRenderer = (args: {
  field: DatabaseTableFieldDescriptor;
  row: DatabaseTableRowDescriptor;
}) => ReactNode;

/** Field-level menu item renderer the host passes in. */
export type DatabaseTableFieldMenuRenderer = (args: {
  field: DatabaseTableFieldDescriptor;
  position: number;
  total: number;
}) => ReactNode;

export interface DatabaseTableViewProps {
  readonly canEditStructure?: boolean;
  readonly canResizeFields?: boolean;
  readonly labels: DatabaseTableLabels;
  readonly fieldTypeLabels: DatabaseTableFieldTypeLabels;
  /**
   * Visible field descriptors in display order. The first cell of every
   * data row is reserved for the row title button, so any descriptor whose
   * `fieldType` is `Title` is excluded from the data-cell loop and rendered
   * only as the row title (parity with the legacy preset).
   */
  readonly fields: DatabaseTableFieldDescriptor[];
  readonly rows: DatabaseTableRowDescriptor[];
  readonly rowTemplates: DatabaseTableRowTemplateDescriptor[];
  readonly renderCell: DatabaseTableCellRenderer;
  readonly renderFieldMenuItems?: DatabaseTableFieldMenuRenderer;
  readonly onCreateField: (args: {
    name: string;
    kind: string;
  }) => void | Promise<void>;
  readonly onCreateRow: () => void | Promise<void>;
  readonly onCreateRowFromTemplate: (
    rowTemplateId: string,
  ) => void | Promise<void>;
  readonly onDeleteRow: (
    row: DatabaseTableRowDescriptor,
  ) => void | Promise<void>;
  readonly onDeleteField: (
    field: DatabaseTableFieldDescriptor,
  ) => void | Promise<void>;
  readonly onFieldRename: (
    field: DatabaseTableFieldDescriptor,
    name: string,
  ) => void | Promise<void>;
  readonly onFieldReorder?: (
    field: DatabaseTableFieldDescriptor,
    direction: -1 | 1,
  ) => void | Promise<void>;
  readonly onFieldResize?: (
    field: DatabaseTableFieldDescriptor,
    width: number,
  ) => void | Promise<void>;
  readonly onOpenRowDetails?: (row: DatabaseTableRowDescriptor) => void;
  readonly onChangeTitle?: (
    rowId: string,
    value: string,
  ) => void | Promise<void>;
  readonly onPasteCells?: (
    row: DatabaseTableRowDescriptor,
    field: DatabaseTableFieldDescriptor,
    value: string,
  ) => void | Promise<void>;
  /**
   * Multi-cell paste contract. When the active selection spans multiple
   * rows/fields the view invokes this once with the parsed TSV rectangle.
   * Hosts that only support single-cell paste can ignore this and wire
   * `onPasteCells` instead.
   */
  readonly onPasteCellsRange?: (args: {
    start: {
      row: DatabaseTableRowDescriptor;
      field: DatabaseTableFieldDescriptor;
    };
    values: string[][];
  }) => void | Promise<void>;
  readonly onFillCells?: (
    row: DatabaseTableRowDescriptor,
    field: DatabaseTableFieldDescriptor,
    value: string,
  ) => void | Promise<void>;
  /**
   * Multi-cell drag fill contract. Same shape as `onPasteCellsRange` but
   * invoked from the cell drag-and-drop handler so the host can treat it
   * as a fill rather than a paste.
   */
  readonly onFillCellsRange?: (args: {
    start: {
      row: DatabaseTableRowDescriptor;
      field: DatabaseTableFieldDescriptor;
    };
    values: string[][];
  }) => void | Promise<void>;
  readonly onRequestFieldConfiguration?: (
    field: DatabaseTableFieldDescriptor,
    trigger: HTMLButtonElement | null,
  ) => void;
  readonly onRequestRowTemplateManagement?: () => void;
  /**
   * Cell-level clipboard text formatter. Hosts that already produce a
   * localised string for each cell (e.g. through `formatCellValue`) should
   * pass their formatter so the active Table view can keep the legacy
   * `copy` behaviour (a tab-separated matrix of the selected range).
   */
  readonly getCellClipboardText?: (
    row: DatabaseTableRowDescriptor,
    field: DatabaseTableFieldDescriptor,
  ) => string;
  /** Optional clear handler invoked when the user cuts selection cells. */
  readonly onClearCells?: (
    cells: Array<{
      row: DatabaseTableRowDescriptor;
      field: DatabaseTableFieldDescriptor;
    }>,
  ) => void | Promise<void>;
  readonly onBulkDeleteRows?: (
    rows: DatabaseTableRowDescriptor[],
  ) => void | Promise<void>;
  readonly onBulkEditRows?: (rows: DatabaseTableRowDescriptor[]) => void;
  readonly onBulkExportRows?: (
    rows: DatabaseTableRowDescriptor[],
  ) => void | Promise<void>;
}

/**
 * Active Myoxus-owned Table surface.
 *
 * The component renders the same workflow surfaces as the legacy
 * preset it replaced (inline edit, paste/fill, field menu,
 * row delete, field rename/reorder/resize, document open, row
 * template insertion) without depending on the legacy data-view
 * preset package.
 */
export function DatabaseTableView(props: DatabaseTableViewProps) {
  const {
    canEditStructure = true,
    canResizeFields = true,
    labels,
    fieldTypeLabels,
    fields,
    rows,
    rowTemplates,
    renderCell,
    renderFieldMenuItems,
    onCreateField,
    onCreateRow,
    onCreateRowFromTemplate,
    onDeleteRow,
    onDeleteField,
    onFieldRename,
    onFieldReorder,
    onFieldResize,
    onOpenRowDetails,
    onPasteCells,
    onPasteCellsRange,
    onFillCells,
    onFillCellsRange,
    onRequestFieldConfiguration,
    onRequestRowTemplateManagement,
    getCellClipboardText,
    onClearCells,
    onBulkDeleteRows,
    onBulkEditRows,
    onBulkExportRows,
  } = props;

  const [createFieldOpen, setCreateFieldOpen] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldKind, setNewFieldKind] = useState<string>(
    DatabaseFieldKind.Text,
  );
  const [createFieldError, setCreateFieldError] = useState<string | null>(null);
  // Active field-creation surface. The facade surface contract is
  // Modal-on-desktop, Drawer-on-compact so the operator never loses the
  // create-field chrome when the viewport shrinks. The contract is
  // owned by the shared facade so the screen reader + size queries
  // stay in one place (P-DB-31).
  const isCompactViewport = useResponsiveSmQuery();

  // All fields (including Title) are rendered through data cells via
  // `renderCell`. Parity with the legacy preset where the title
  // field was just another field cell with its own InlineEdit
  // (no dedicated title-button cell).
  const dataFields = fields;

  const createableKinds = useMemo<(keyof DatabaseTableFieldTypeLabels)[]>(
    () => [
      DatabaseFieldKind.Text,
      DatabaseFieldKind.RichText,
      DatabaseFieldKind.Number,
      DatabaseFieldKind.Percent,
      DatabaseFieldKind.Currency,
      DatabaseFieldKind.Duration,
      DatabaseFieldKind.Select,
      DatabaseFieldKind.MultiSelect,
      DatabaseFieldKind.Tags,
      DatabaseFieldKind.Status,
      DatabaseFieldKind.Checkbox,
      DatabaseFieldKind.Date,
      DatabaseFieldKind.DateTime,
      DatabaseFieldKind.Files,
      DatabaseFieldKind.Url,
      DatabaseFieldKind.Email,
      DatabaseFieldKind.Phone,
      DatabaseFieldKind.User,
      DatabaseFieldKind.Users,
    ],
    [],
  );

  const createFieldBody = (
    <Stack gap="md">
      <Input
        label={labels.fieldName}
        value={newFieldName}
        onChange={(value) => setNewFieldName(value)}
        data-testid="database-table-create-field-name"
      />
      <Select
        label={labels.fieldType}
        value={newFieldKind}
        onChange={(value) => setNewFieldKind(value ?? DatabaseFieldKind.Text)}
        data={createableKinds.map((kind) => ({
          value: kind,
          label: fieldTypeLabels[kind],
        }))}
        data-testid="database-table-create-field-kind"
      />
      {createFieldError ? (
        <Badge tone="error" data-testid="database-table-create-field-error">
          {createFieldError}
        </Badge>
      ) : null}
      <Group justify="end" gap="xs">
        <Button
          variant="ghost"
          onClick={() => setCreateFieldOpen(false)}
          data-testid="database-table-create-field-cancel"
        >
          {labels.cancel}
        </Button>
        <Button
          variant="primary"
          onClick={() => void submitCreateField()}
          data-testid="database-table-create-field-submit"
        >
          {labels.createField}
        </Button>
      </Group>
    </Stack>
  );

  const submitCreateField = useCallback(async () => {
    if (!newFieldName.trim()) {
      setCreateFieldError(labels.fieldCreateValidation);
      return;
    }
    await onCreateField({ name: newFieldName.trim(), kind: newFieldKind });
    setCreateFieldOpen(false);
    setNewFieldName("");
    setNewFieldKind(DatabaseFieldKind.Text);
    setCreateFieldError(null);
  }, [labels.fieldCreateValidation, newFieldKind, newFieldName, onCreateField]);

  // Cell-level interaction state — focused cell, multi-cell selection, and
  // the active drag-fill source. Parity with the legacy preset
  // keyboard/copy/paste/drag contract so the host test suite still passes.
  const [selectedRange, setSelectedRange] = useState<{
    anchor: { rowId: string; fieldId: string };
    focus: { rowId: string; fieldId: string };
  } | null>(null);
  const selectedBounds = useMemo(() => {
    if (!selectedRange) return null;
    const rowIds = rows.map((row) => row.id);
    const fieldIds = fields.map((field) => field.id);
    const anchorRow = rowIds.indexOf(selectedRange.anchor.rowId);
    const focusRow = rowIds.indexOf(selectedRange.focus.rowId);
    const anchorField = fieldIds.indexOf(selectedRange.anchor.fieldId);
    const focusField = fieldIds.indexOf(selectedRange.focus.fieldId);
    if (anchorRow < 0 || focusRow < 0 || anchorField < 0 || focusField < 0) {
      return null;
    }
    return {
      fieldEnd: Math.max(anchorField, focusField),
      fieldStart: Math.min(anchorField, focusField),
      rowEnd: Math.max(anchorRow, focusRow),
      rowStart: Math.min(anchorRow, focusRow),
    };
  }, [fields, rows, selectedRange]);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkDeleteRows, setBulkDeleteRows] = useState<
    DatabaseTableRowDescriptor[] | null
  >(null);
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedRowIds.has(row.id)),
    [rows, selectedRowIds],
  );
  const selectableRowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const allRowsSelected =
    selectableRowIds.length > 0 &&
    selectableRowIds.every((rowId) => selectedRowIds.has(rowId));
  const someRowsSelected = selectedRows.length > 0 && !allRowsSelected;

  const toggleRowSelection = useCallback((rowId: string, checked: boolean) => {
    setSelectedRowIds((current) => {
      const next = new Set(current);
      if (checked) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  }, []);

  const toggleAllRows = useCallback(
    (checked: boolean) => {
      setSelectedRowIds(checked ? new Set(selectableRowIds) : new Set());
    },
    [selectableRowIds],
  );

  useEffect(() => {
    setSelectedRowIds((current) => {
      const live = new Set(selectableRowIds);
      const next = new Set([...current].filter((rowId) => live.has(rowId)));
      return next.size === current.size ? current : next;
    });
  }, [selectableRowIds]);

  const focusCell = useCallback(
    (cell: { rowId: string; fieldId: string }, extend: boolean) => {
      setSelectedRange((current) => {
        if (extend && current) {
          return { anchor: current.anchor, focus: cell };
        }
        return { anchor: cell, focus: cell };
      });
    },
    [],
  );

  const nextCellCoord = useCallback(
    (
      current: { rowId: string; fieldId: string },
      drow: number,
      dcol: number,
    ) => {
      const rowIndex = rows.findIndex((row) => row.id === current.rowId);
      const fieldIndex = fields.findIndex(
        (field) => field.id === current.fieldId,
      );
      if (rowIndex < 0 || fieldIndex < 0) return current;
      const newRowIndex = Math.max(
        0,
        Math.min(rows.length - 1, rowIndex + drow),
      );
      const newFieldIndex = Math.max(
        0,
        Math.min(fields.length - 1, fieldIndex + dcol),
      );
      return {
        rowId: rows[newRowIndex]!.id,
        fieldId: fields[newFieldIndex]!.id,
      };
    },
    [rows, fields],
  );

  const handleCellKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLTableCellElement>,
      row: DatabaseTableRowDescriptor,
      field: DatabaseTableFieldDescriptor,
    ) => {
      const focus = selectedRange?.focus ?? {
        rowId: row.id,
        fieldId: field.id,
      };
      if (event.key === "ArrowRight") {
        event.preventDefault();
        focusCell(nextCellCoord(focus, 0, 1), event.shiftKey);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusCell(nextCellCoord(focus, 0, -1), event.shiftKey);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusCell(nextCellCoord(focus, 1, 0), event.shiftKey);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusCell(nextCellCoord(focus, -1, 0), event.shiftKey);
        return;
      }
    },
    [focusCell, nextCellCoord, selectedRange],
  );

  /**
   * Render the selection rectangle as TSV text. For each row in the
   * selected range, emit the cell values tab-separated. Mirrors the legacy
   * `clipboardRows` + `matrixToTsv` helpers.
   */
  const buildSelectionTsv = useCallback((): string => {
    if (!selectedRange) return "";
    const rowIds = rows.map((row) => row.id);
    const fieldIds = fields.map((field) => field.id);
    const focusRowIdx = rowIds.indexOf(selectedRange.focus.rowId);
    const anchorRowIdx = rowIds.indexOf(selectedRange.anchor.rowId);
    const focusColIdx = fieldIds.indexOf(selectedRange.focus.fieldId);
    const anchorColIdx = fieldIds.indexOf(selectedRange.anchor.fieldId);
    const rowStart = Math.min(focusRowIdx, anchorRowIdx);
    const rowEnd = Math.max(focusRowIdx, anchorRowIdx);
    const colStart = Math.min(focusColIdx, anchorColIdx);
    const colEnd = Math.max(focusColIdx, anchorColIdx);
    const lines: string[] = [];
    for (let r = rowStart; r <= rowEnd; r += 1) {
      const row = rows[r];
      if (!row) continue;
      const cells: string[] = [];
      for (let c = colStart; c <= colEnd; c += 1) {
        const field = fields[c];
        if (!field) continue;
        const text = getCellClipboardText
          ? getCellClipboardText(row, field)
          : (row.title ?? "");
        cells.push(text);
      }
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }, [fields, getCellClipboardText, rows, selectedRange]);

  const handleCopy = useCallback(
    (event: React.ClipboardEvent<HTMLTableCellElement>) => {
      if (!selectedRange) return;
      event.preventDefault();
      const text = buildSelectionTsv();
      event.clipboardData.setData("text/plain", text);
    },
    [buildSelectionTsv, selectedRange],
  );

  const handleCut = useCallback(
    (event: React.ClipboardEvent<HTMLTableCellElement>) => {
      if (!selectedRange) return;
      handleCopy(event);
      if (!onClearCells) return;
      const rowIds = rows.map((row) => row.id);
      const fieldIds = fields.map((field) => field.id);
      const focusRowIdx = rowIds.indexOf(selectedRange.focus.rowId);
      const anchorRowIdx = rowIds.indexOf(selectedRange.anchor.rowId);
      const focusColIdx = fieldIds.indexOf(selectedRange.focus.fieldId);
      const anchorColIdx = fieldIds.indexOf(selectedRange.anchor.fieldId);
      const rowStart = Math.min(focusRowIdx, anchorRowIdx);
      const rowEnd = Math.max(focusRowIdx, anchorRowIdx);
      const colStart = Math.min(focusColIdx, anchorColIdx);
      const colEnd = Math.max(focusColIdx, anchorColIdx);
      const cells: Array<{
        row: DatabaseTableRowDescriptor;
        field: DatabaseTableFieldDescriptor;
      }> = [];
      for (let r = rowStart; r <= rowEnd; r += 1) {
        const row = rows[r];
        if (!row) continue;
        for (let c = colStart; c <= colEnd; c += 1) {
          const field = fields[c];
          if (!field) continue;
          cells.push({ row, field });
        }
      }
      void onClearCells(cells);
    },
    [fields, handleCopy, onClearCells, rows, selectedRange],
  );

  const handlePaste = useCallback(
    (
      event: React.ClipboardEvent<HTMLTableCellElement>,
      row: DatabaseTableRowDescriptor,
      field: DatabaseTableFieldDescriptor,
    ) => {
      const eventTarget = event.target;
      if (
        eventTarget instanceof HTMLElement &&
        eventTarget !== event.currentTarget &&
        eventTarget.closest(
          "input, textarea, select, [contenteditable='true'], [role='textbox']",
        )
      ) {
        // Nested editors own their clipboard input. Letting the table range
        // handler process the same event would issue an additional cell write
        // and can replace structured values such as RichText with plain text.
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      const values = text
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => line.split("\t"));
      if (!values.length) return;
      event.preventDefault();
      if (onPasteCellsRange) {
        void onPasteCellsRange({ start: { row, field }, values });
        return;
      }
      if (!onPasteCells) return;
      const startFieldIdx = fields.findIndex((f) => f.id === field.id);
      const startRowIdx = rows.findIndex((r) => r.id === row.id);
      if (startFieldIdx < 0 || startRowIdx < 0) return;
      values.forEach((rowValues, rowOffset) => {
        rowValues.forEach((value, fieldOffset) => {
          const targetField = fields[startFieldIdx + fieldOffset];
          const targetRow = rows[startRowIdx + rowOffset];
          if (!targetField || !targetRow) return;
          void onPasteCells(targetRow, targetField, value);
        });
      });
    },
    [fields, onPasteCells, onPasteCellsRange, rows],
  );

  const dragFillSourceRef = useRef<{
    row: DatabaseTableRowDescriptor;
    field: DatabaseTableFieldDescriptor;
    text: string;
  } | null>(null);

  const handleCellDragStart = useCallback(
    (
      event: React.DragEvent<HTMLTableCellElement>,
      row: DatabaseTableRowDescriptor,
      field: DatabaseTableFieldDescriptor,
    ) => {
      const text = getCellClipboardText
        ? getCellClipboardText(row, field)
        : (row.title ?? "");
      dragFillSourceRef.current = { row, field, text };
      event.dataTransfer.setData("text/plain", text);
      event.dataTransfer.effectAllowed = "copy";
    },
    [getCellClipboardText],
  );

  const handleCellDragOver = useCallback(
    (event: React.DragEvent<HTMLTableCellElement>) => {
      if (!dragFillSourceRef.current) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleCellDrop = useCallback(
    (
      event: React.DragEvent<HTMLTableCellElement>,
      row: DatabaseTableRowDescriptor,
      field: DatabaseTableFieldDescriptor,
    ) => {
      const source = dragFillSourceRef.current;
      if (!source) return;
      event.preventDefault();
      if (onFillCellsRange) {
        void onFillCellsRange({
          start: { row, field },
          values: [[source.text]],
        });
      } else if (onFillCells) {
        void onFillCells(row, field, source.text);
      }
      dragFillSourceRef.current = null;
    },
    [onFillCells, onFillCellsRange],
  );

  // Header drag-reorder state.
  const draggedFieldIdRef = useRef<string | null>(null);
  const handleFieldDragStart = useCallback(
    (
      event: React.DragEvent<HTMLTableCellElement>,
      field: DatabaseTableFieldDescriptor,
    ) => {
      draggedFieldIdRef.current = field.id;
      event.dataTransfer.setData("text/plain", field.id);
      event.dataTransfer.effectAllowed = "move";
    },
    [],
  );
  const handleFieldDragOver = useCallback(
    (event: React.DragEvent<HTMLTableCellElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    [],
  );
  const handleFieldDrop = useCallback(
    (
      event: React.DragEvent<HTMLTableCellElement>,
      field: DatabaseTableFieldDescriptor,
    ) => {
      const draggedId = draggedFieldIdRef.current;
      if (!draggedId || draggedId === field.id || !onFieldReorder) return;
      event.preventDefault();
      const fromIdx = fields.findIndex((f) => f.id === draggedId);
      const toIdx = fields.findIndex((f) => f.id === field.id);
      if (fromIdx < 0 || toIdx < 0) return;
      const direction: -1 | 1 = toIdx < fromIdx ? -1 : 1;
      const moved = fields[fromIdx];
      if (moved) void onFieldReorder(moved, direction);
      draggedFieldIdRef.current = null;
    },
    [fields, onFieldReorder],
  );

  /**
   * On first render with rows/fields available, seed the focused cell so
   * keyboard/copy/paste handlers have a stable anchor (parity with the
   * legacy preset).
   */
  useEffect(() => {
    if (selectedRange) return;
    if (!rows.length || !fields.length) return;
    const firstRow = rows[0]!;
    const firstField = fields[0]!;
    setSelectedRange({
      anchor: { rowId: firstRow.id, fieldId: firstField.id },
      focus: { rowId: firstRow.id, fieldId: firstField.id },
    });
  }, [fields, rows, selectedRange]);

  return (
    <Stack
      gap="xs"
      data-testid="database-table-view"
      data-myoxus-ui-role="database-table-view"
    >
      {selectedRows.length > 0 ? (
        <Group
          role="toolbar"
          aria-label={labels.bulkActionsTitle}
          justify="space-between"
          gap="xs"
          wrap="wrap"
          data-testid="database-bulk-selection-toolbar"
          data-myoxus-ui-role="database-bulk-selection-toolbar"
        >
          <MyoxusText typographySlot="body-small" tone="secondary">
            {labels.bulkSelectedCount(selectedRows.length)}
          </MyoxusText>
          <Group gap="xs" wrap="wrap">
            {onBulkEditRows ? (
              <Button
                size="sm"
                variant="secondary"
                data-testid="database-bulk-edit-selected"
                onClick={() => onBulkEditRows(selectedRows)}
              >
                {labels.bulkEdit}
              </Button>
            ) : null}
            {onBulkExportRows ? (
              <Button
                size="sm"
                variant="secondary"
                data-testid="database-bulk-export-selected"
                onClick={() => void onBulkExportRows(selectedRows)}
              >
                {labels.bulkExportSelected}
              </Button>
            ) : null}
            {onBulkDeleteRows ? (
              <Button
                size="sm"
                variant="error"
                data-testid="database-bulk-delete-selected"
                onClick={() => setBulkDeleteRows(selectedRows)}
              >
                {labels.bulkDelete}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              data-testid="database-bulk-clear-selection"
              onClick={() => setSelectedRowIds(new Set())}
            >
              {labels.clearSelection}
            </Button>
          </Group>
        </Group>
      ) : null}
      <TableScrollContainer>
        <Table
          role="grid"
          data-testid="database-table-grid"
          highlightOnHover
          miw="100%"
          stickyHeader
          w="max-content"
          withColumnBorders
          withTableBorder
        >
          <TableHeader>
            <TableRow>
              <TableHead
                role="columnheader"
                data-testid="database-table-selection-header"
              >
                <Checkbox
                  aria-label={labels.selectAllRows}
                  checked={allRowsSelected}
                  indeterminate={someRowsSelected}
                  onChange={(_, checked) => toggleAllRows(checked)}
                  data-testid="database-table-select-all"
                />
              </TableHead>
              <TableHead role="columnheader" aria-label={labels.rowMenu} />
              {dataFields.map((field, index) => (
                <DatabaseTableHeaderCell
                  key={field.id}
                  canEditStructure={canEditStructure}
                  canResizeFields={canResizeFields}
                  field={field}
                  position={index}
                  total={fields.length}
                  labels={labels}
                  onRename={(name) => onFieldRename(field, name)}
                  onResize={(width) => onFieldResize?.(field, width)}
                  onReorder={(direction) => onFieldReorder?.(field, direction)}
                  onRequestConfiguration={(trigger) =>
                    onRequestFieldConfiguration?.(field, trigger)
                  }
                  onDelete={() => onDeleteField(field)}
                  renderMenuItems={renderFieldMenuItems}
                  onDragStart={(event) => handleFieldDragStart(event, field)}
                  onDragOver={handleFieldDragOver}
                  onDrop={(event) => handleFieldDrop(event, field)}
                />
              ))}
              {canEditStructure ? (
                <TableHead role="columnheader">
                  <IconButton
                    data-testid="database-field-plus"
                    aria-label={labels.fieldPlus}
                    tooltip={labels.fieldPlus}
                    onClick={() => setCreateFieldOpen(true)}
                  >
                    <PlusIcon aria-hidden="true" />
                  </IconButton>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow data-testid="database-table-empty">
                <TableCell colSpan={dataFields.length + 3} muted>
                  {labels.emptyRows}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, rowIndex) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Checkbox
                      aria-label={`${labels.selectRow}: ${row.title}`}
                      checked={selectedRowIds.has(row.id)}
                      onChange={(_, checked) =>
                        toggleRowSelection(row.id, checked)
                      }
                      data-testid="database-table-select-row"
                    />
                  </TableCell>
                  <TableCell>
                    <Menu
                      items={
                        <>
                          {onOpenRowDetails ? (
                            <MenuItem
                              key="open"
                              onSelect={() => onOpenRowDetails(row)}
                            >
                              {labels.openRowDetails}
                            </MenuItem>
                          ) : null}
                          {rowTemplates
                            .filter((template) => template.available)
                            .map((template) => (
                              <MenuItem
                                key={`template:${template.id}`}
                                onSelect={() =>
                                  onCreateRowFromTemplate(template.id)
                                }
                              >
                                {template.label}
                              </MenuItem>
                            ))}
                          <MenuItem
                            key="delete"
                            type="danger"
                            onSelect={() => onDeleteRow(row)}
                          >
                            {labels.deleteRow}
                          </MenuItem>
                        </>
                      }
                    >
                      <IconButton
                        aria-label={labels.rowMenu}
                        tooltip={labels.rowMenu}
                        data-testid="database-new-row-menu"
                      >
                        <MoreHorizontalIcon aria-hidden="true" />
                      </IconButton>
                    </Menu>
                  </TableCell>
                  {dataFields.map((field, fieldIndex) => {
                    const editable =
                      isDatabaseTableCellEditableFromDescriptor(field);
                    const isSelectionFocus =
                      selectedRange?.focus.fieldId === field.id &&
                      selectedRange?.focus.rowId === row.id;
                    const isSelected = Boolean(
                      selectedBounds &&
                      rowIndex >= selectedBounds.rowStart &&
                      rowIndex <= selectedBounds.rowEnd &&
                      fieldIndex >= selectedBounds.fieldStart &&
                      fieldIndex <= selectedBounds.fieldEnd,
                    );
                    return (
                      <TableCell
                        role="gridcell"
                        tabIndex={0}
                        key={`${row.id}:${field.id}`}
                        selected={isSelected}
                        selectionFocus={isSelectionFocus}
                        data-testid="database-cell"
                        data-field-id={field.id}
                        data-row-id={row.id}
                        onClick={() =>
                          focusCell({ rowId: row.id, fieldId: field.id }, false)
                        }
                        onKeyDown={(event) =>
                          handleCellKeyDown(event, row, field)
                        }
                        onCopy={handleCopy}
                        onCut={handleCut}
                        onPaste={(event) => handlePaste(event, row, field)}
                        draggable={editable}
                        onDragStart={(event) =>
                          handleCellDragStart(event, row, field)
                        }
                        onDragOver={handleCellDragOver}
                        onDrop={(event) => handleCellDrop(event, row, field)}
                      >
                        {renderCell({ field, row })}
                        {editable && onPasteCells ? (
                          <PasteShim
                            onPaste={(value) => onPasteCells(row, field, value)}
                            onFill={(value) => onFillCells?.(row, field, value)}
                          />
                        ) : null}
                      </TableCell>
                    );
                  })}
                  <TableCell />
                </TableRow>
              ))
            )}
            <TableRow>
              <TableCell colSpan={dataFields.length + 3}>
                <Button
                  variant="link"
                  prefix={<PlusIcon aria-hidden="true" />}
                  data-testid="database-new-row"
                  aria-label={labels.newRow}
                  onClick={() => onCreateRow()}
                >
                  {labels.newRow}
                </Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableScrollContainer>

      {rowTemplates.length > 0 ? (
        <Group justify="end" gap="xs">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onRequestRowTemplateManagement?.()}
            data-testid="database-table-row-templates"
          >
            {labels.manageRowTemplates}
          </Button>
        </Group>
      ) : null}

      {isCompactViewport ? (
        <Drawer
          open={createFieldOpen}
          onClose={() => setCreateFieldOpen(false)}
          title={labels.createField}
          position="bottom"
        >
          {createFieldBody}
        </Drawer>
      ) : (
        <Modal
          open={createFieldOpen}
          onOpenChange={setCreateFieldOpen}
          title={labels.createField}
        >
          {createFieldBody}
        </Modal>
      )}
      <Modal
        open={Boolean(bulkDeleteRows)}
        onOpenChange={(open) => {
          if (!open) setBulkDeleteRows(null);
        }}
        title={labels.bulkDeleteConfirmTitle(bulkDeleteRows?.length ?? 0)}
      >
        <Stack gap="md">
          <MyoxusText>{labels.bulkDeleteConfirmBody}</MyoxusText>
          <Group justify="flex-end" gap="xs">
            <Button variant="secondary" onClick={() => setBulkDeleteRows(null)}>
              {labels.cancel}
            </Button>
            <Button
              variant="error"
              data-testid="database-bulk-confirm-delete"
              onClick={() => {
                if (bulkDeleteRows) void onBulkDeleteRows?.(bulkDeleteRows);
                setBulkDeleteRows(null);
              }}
            >
              {labels.bulkDeleteConfirmConfirm}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

interface DatabaseTableHeaderCellProps {
  canEditStructure: boolean;
  canResizeFields: boolean;
  field: DatabaseTableFieldDescriptor;
  position: number;
  total: number;
  labels: DatabaseTableLabels;
  onRename: (name: string) => void;
  onResize: (width: number) => void;
  onReorder: (direction: -1 | 1) => void;
  onRequestConfiguration: (trigger: HTMLButtonElement | null) => void;
  onDelete: () => void;
  renderMenuItems?: DatabaseTableFieldMenuRenderer;
  onDragStart?: (event: React.DragEvent<HTMLTableCellElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLTableCellElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLTableCellElement>) => void;
}

function DatabaseTableHeaderCell(props: DatabaseTableHeaderCellProps) {
  const {
    canEditStructure,
    canResizeFields,
    field,
    position,
    total,
    labels,
    onRename,
    onResize,
    onReorder,
    onRequestConfiguration,
    onDelete,
    renderMenuItems,
    onDragStart,
    onDragOver,
    onDrop,
  } = props;
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <TableHead
      role="columnheader"
      w={field.width ?? undefined}
      data-testid="database-field-header"
      data-field-id={field.id}
      data-field-unsupported={field.unsupported ? "true" : undefined}
      aria-sort={
        field.sortDirection === "asc"
          ? "ascending"
          : field.sortDirection === "desc"
            ? "descending"
            : "none"
      }
      draggable={
        canEditStructure && field.fieldType !== DatabaseFieldKind.Title
      }
      onDragStart={(event) => onDragStart?.(event)}
      onDragOver={(event) => onDragOver?.(event)}
      onDrop={(event) => onDrop?.(event)}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <InlineEdit
            value={field.label}
            editable={
              canEditStructure &&
              !field.readonly &&
              field.fieldType !== DatabaseFieldKind.Title
            }
            trigger="doubleClick"
            onChange={(name) => onRename(name)}
            inputAttrs={{ "aria-label": `Rename ${field.label}` }}
            data-testid="database-table-field-name-input"
          />
          {field.sortDirection && field.sortPriority ? (
            <Badge
              tone="info"
              data-testid="database-table-active-sort"
              aria-label={`${field.sortDirection === "asc" ? labels.sortAscending : labels.sortDescending}, ${field.sortPriority}`}
            >
              {field.sortDirection === "asc"
                ? labels.sortAscending
                : labels.sortDescending}
              {` · ${field.sortPriority}`}
            </Badge>
          ) : null}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Menu
            items={
              <>
                {canEditStructure ? (
                  <>
                    <MenuItem
                      key="configure"
                      data-testid="database-table-configure-field"
                      disabled={
                        field.fieldType === DatabaseFieldKind.Title ||
                        field.unsupported
                      }
                      onSelect={() => {
                        if (
                          field.fieldType === DatabaseFieldKind.Title ||
                          field.unsupported
                        ) {
                          return;
                        }
                        onRequestConfiguration(menuTriggerRef.current);
                      }}
                    >
                      {labels.fieldConfigure}
                    </MenuItem>
                    <MenuItem
                      key="reorder-left"
                      disabled={position <= 0}
                      onSelect={() => onReorder(-1)}
                    >
                      {labels.fieldMoveLeft}
                    </MenuItem>
                    <MenuItem
                      key="reorder-right"
                      disabled={position >= total - 1}
                      onSelect={() => onReorder(1)}
                    >
                      {labels.fieldMoveRight}
                    </MenuItem>
                  </>
                ) : null}
                {canResizeFields ? (
                  <MenuItem
                    key="resize"
                    onSelect={() =>
                      onResize(Math.max(80, (field.width ?? 160) + 40))
                    }
                  >
                    {labels.fieldResize}
                  </MenuItem>
                ) : null}
                {renderMenuItems ? (
                  <span key="host-extras">
                    {renderMenuItems({ field, position, total })}
                  </span>
                ) : null}
                {canEditStructure ? (
                  <MenuItem
                    key="delete"
                    type="danger"
                    onSelect={() => onDelete()}
                  >
                    {labels.deleteField}
                  </MenuItem>
                ) : null}
              </>
            }
          >
            <IconButton
              ref={menuTriggerRef}
              aria-label={`${canEditStructure ? labels.fieldConfigure : labels.viewMenu}: ${field.label}`}
              tooltip={`${canEditStructure ? labels.fieldConfigure : labels.viewMenu}: ${field.label}`}
              data-testid="database-table-field-menu-trigger"
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </IconButton>
          </Menu>
          {canResizeFields ? (
            <span
              aria-hidden="true"
              data-testid="database-field-resize-handle"
              role="separator"
              onPointerDown={(event) => {
                const startX = event.clientX;
                // Column width and pointer hit geometry are persisted editor
                // measurement, not product chrome. Native Mantine owns all
                // visible table styling around this narrow resize exception.
                const header = event.currentTarget.closest(
                  "[role='columnheader']",
                );
                const measuredWidth =
                  header?.getBoundingClientRect().width ?? 0;
                const startWidth =
                  field.width ?? (measuredWidth > 0 ? measuredWidth : 96);
                const target = event.currentTarget;
                let nextWidth = startWidth;
                const move = (ev: PointerEvent) => {
                  nextWidth = Math.max(80, startWidth + (ev.clientX - startX));
                  target.setAttribute("data-current-width", String(nextWidth));
                };
                const up = (ev?: PointerEvent) => {
                  target.removeEventListener("pointermove", move);
                  target.removeEventListener("pointerup", up);
                  if (ev) {
                    nextWidth = Math.max(
                      80,
                      startWidth + (ev.clientX - startX),
                    );
                  }
                  onResize(nextWidth);
                };
                target.addEventListener("pointermove", move);
                target.addEventListener("pointerup", up);
              }}
              style={{
                alignSelf: "stretch",
                cursor: "col-resize",
                touchAction: "none",
                width: "6px",
              }}
            />
          ) : null}
        </Group>
      </Group>
    </TableHead>
  );
}

/**
 * Paste / fill capture shim. The component renders a hidden input the
 * host's keyboard handler can focus and feed values into.
 */
function PasteShim(props: {
  onPaste: (value: string) => void;
  onFill: (value: string) => void;
}) {
  return (
    <input
      aria-hidden="true"
      tabIndex={-1}
      style={{ display: "none" }}
      onPaste={(event) => {
        const text = event.clipboardData.getData("text/plain");
        if (text) props.onPaste(text);
      }}
      onInput={(event) => props.onFill(event.currentTarget.value)}
      data-testid="database-table-paste-shim"
    />
  );
}

/** Mirrors `isDatabaseTableCellEditable` against the descriptor shape. */
function isDatabaseTableCellEditableFromDescriptor(
  descriptor: DatabaseTableFieldDescriptor,
): boolean {
  return (
    descriptor.fieldType === DatabaseFieldKind.Title ||
    (!descriptor.readonly && !descriptor.unsupported)
  );
}
