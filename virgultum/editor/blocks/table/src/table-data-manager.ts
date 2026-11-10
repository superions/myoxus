import { computed, type ReadonlySignal, signal } from "@preact/signals-core";
import type {
  TableAppearance,
  TableBlockModel,
  TableCell,
  TableRow,
  TableColumn,
  TableDensity,
  TextAlign,
  TemplateRepeatBinding,
} from "@virgultum/model";
import {
  normalizeTableAppearance,
  normalizeTableDensity,
  normalizeTableHeaderRows,
} from "@virgultum/model";
import { generateFractionalIndexingKeyBetween } from "@virgultum/shared/utils";
import { cloneTextWithDocumentFieldIdentities } from "@virgultum/shared/types";
import { nanoid, Text, canChangeFixedTextProperty } from "@virgultum/store";

import type { TableAreaSelection } from "./selection-schema";
import { compareTableOrder } from "./utils";

export class TableDataManager {
  constructor(private readonly model: TableBlockModel) {}

  hasFixedRow(rowId: string) {
    return this.columns$.value.some(
      ({ columnId }) =>
        this.getCell(rowId, columnId)?.textProtection === "fixed",
    );
  }

  hasFixedColumn(columnId: string) {
    return this.rows$.value.some(
      ({ rowId }) => this.getCell(rowId, columnId)?.textProtection === "fixed",
    );
  }
  readonly readonly$: ReadonlySignal<boolean> = computed(() => {
    return this.model.store.readonly;
  });
  readonly ui = {
    columnIndicatorIndex$: signal<number>(),
    rowIndicatorIndex$: signal<number>(),
  };
  readonly hoverColumnIndex$ = signal<number>();
  readonly hoverRowIndex$ = signal<number>();
  readonly hoverDragHandleColumnId$ = signal<string>();
  readonly widthAdjustColumnId$ = signal<string>();
  readonly virtualColumnCount$ = signal<number>(0);
  readonly virtualRowCount$ = signal<number>(0);
  readonly virtualWidth$ = signal<
    { columnId: string; width: number } | undefined
  >();
  readonly cellCountTips$ = computed(
    () =>
      `${this.virtualRowCount$.value + this.rows$.value.length} x ${this.virtualColumnCount$.value + this.columns$.value.length}`,
  );
  readonly rows$ = computed(() => {
    return Object.values(this.model.props.rows$.value).sort((a, b) =>
      compareTableOrder(a.order, a.rowId, b.order, b.rowId),
    );
  });

  readonly headerRows$ = computed(() => {
    const value = this.model.props.headerRows$.value;
    return value === undefined
      ? undefined
      : normalizeTableHeaderRows(value, this.rows$.value.length);
  });

  readonly appearance$ = computed(() =>
    normalizeTableAppearance(this.model.props.appearance$.value),
  );

  readonly density$ = computed(() =>
    normalizeTableDensity(this.model.props.density$.value),
  );

  readonly columns$ = computed(() => {
    return Object.values(this.model.props.columns$.value).sort((a, b) =>
      compareTableOrder(a.order, a.columnId, b.order, b.columnId),
    );
  });

  readonly uiRows$ = computed(() => {
    const virtualRowCount = this.virtualRowCount$.value;
    const rows = this.rows$.value;
    if (virtualRowCount === 0) {
      return rows;
    }
    if (virtualRowCount > 0) {
      return [
        ...rows,
        ...Array.from({ length: virtualRowCount }, (_, i) => ({
          rowId: `${i}`,
          backgroundColor: undefined,
        })),
      ];
    }
    return rows.slice(0, rows.length + virtualRowCount);
  });

  readonly uiColumns$ = computed(() => {
    const virtualColumnCount = this.virtualColumnCount$.value;
    const columns = this.columns$.value;
    if (virtualColumnCount === 0) {
      return columns;
    }
    if (virtualColumnCount > 0) {
      return [
        ...columns,
        ...Array.from({ length: virtualColumnCount }, (_, i) => ({
          columnId: `${i}`,
          backgroundColor: undefined,
          width: undefined,
        })),
      ];
    }
    return columns.slice(0, columns.length + virtualColumnCount);
  });

  getCell(rowId: string, columnId: string): TableCell | undefined {
    return this.model.props.cells$.value[`${rowId}:${columnId}`];
  }

  isExplicitHeaderRow(rowIndex: number) {
    const headerRows = this.headerRows$.value;
    return headerRows !== undefined && rowIndex < headerRows;
  }

  canSetRowRepeat(rowId: string) {
    const rowIndex = this.rows$.value.findIndex((row) => row.rowId === rowId);
    return rowIndex >= 0 && !this.isExplicitHeaderRow(rowIndex);
  }

  setHeaderRows(value: number) {
    if (this.readonly$.value) return false;
    const rows = this.rows$.value;
    const headerRows = normalizeTableHeaderRows(value, rows.length);
    if (rows.slice(0, headerRows).some((row) => row.repeat !== undefined)) {
      return false;
    }
    if (
      this.model.props.headerRows$.value !== undefined &&
      this.headerRows$.value === headerRows
    ) {
      return true;
    }
    this.model.store.captureSync();
    this.model.store.updateBlock(this.model, { headerRows });
    this.model.store.captureSync();
    return true;
  }

  setAppearance(appearance: TableAppearance) {
    if (
      this.readonly$.value ||
      this.model.props.appearance$.value === appearance
    )
      return;
    this.model.store.captureSync();
    this.model.store.updateBlock(this.model, { appearance });
    this.model.store.captureSync();
  }

  setDensity(density: TableDensity) {
    if (this.readonly$.value || this.model.props.density$.value === density)
      return;
    this.model.store.captureSync();
    this.model.store.updateBlock(this.model, { density });
    this.model.store.captureSync();
  }

  setRowRepeat(rowId: string, repeat: TemplateRepeatBinding | undefined) {
    const row = this.model.props.rows[rowId];
    if (
      this.readonly$.value ||
      !row ||
      (repeat !== undefined && !this.canSetRowRepeat(rowId))
    )
      return false;
    this.model.store.captureSync();
    const next = { ...row };
    if (repeat === undefined) delete next.repeat;
    else next.repeat = repeat;
    // Flat row replacement deletes old keys before inserting new keys. Keep
    // both halves in one native transaction and one undo boundary.
    this.model.store.transact(() => {
      this.model.props.rows[rowId] = next;
    });
    this.model.store.captureSync();
    return true;
  }

  addRow(after?: number) {
    const rows = this.rows$.value;
    const order = this.getOrder(rows, after);
    const insertionIndex = after == null || after < 0 ? 0 : after + 1;
    const headerRows = this.headerRows$.value;
    const rowId = nanoid();
    this.model.store.transact(() => {
      this.model.props.rows[rowId] = {
        rowId,
        order,
      };

      this.columns$.value.forEach((column) => {
        this.model.props.cells[`${rowId}:${column.columnId}`] = {
          text: new Text(),
        };
      });
      if (headerRows !== undefined && insertionIndex < headerRows) {
        this.model.props.headerRows = headerRows + 1;
      }
    });
    return rowId;
  }
  addNRow(count: number) {
    if (count === 0) {
      return;
    }
    if (count > 0) {
      this.model.store.transact(() => {
        for (let i = 0; i < count; i++) {
          this.addRow(this.rows$.value.length - 1);
        }
      });
    } else {
      const rows = this.rows$.value;
      const rowCount = rows.length;
      if (
        rows
          .slice(rowCount + count, rowCount)
          .some((row) => this.hasFixedRow(row.rowId))
      )
        return;
      this.model.store.transact(() => {
        rows.slice(rowCount + count, rowCount).forEach((row) => {
          this.deleteRow(row.rowId);
        });
      });
    }
  }

  addNColumn(count: number) {
    if (count === 0) {
      return;
    }
    if (count > 0) {
      this.model.store.transact(() => {
        for (let i = 0; i < count; i++) {
          this.addColumn(this.columns$.value.length - 1);
        }
      });
    } else {
      const columns = this.columns$.value;
      const columnCount = columns.length;
      if (
        columns
          .slice(columnCount + count, columnCount)
          .some((column) => this.hasFixedColumn(column.columnId))
      )
        return;
      this.model.store.transact(() => {
        columns.slice(columnCount + count, columnCount).forEach((column) => {
          this.deleteColumn(column.columnId);
        });
      });
    }
  }

  private getOrder(array: (TableRow | TableColumn)[], after?: number) {
    if (array.some((entry) => /^\d{8}$/.test(entry.order))) {
      // Deployed server imports used eight-digit ordinal keys. On the first
      // structural edit, deterministically convert the already sorted axis;
      // retain IDs, cells, header positions and the document's undo history.
      const normalized = array.map((entry, index) => ({
        ...entry,
        order: `a0${String(index).padStart(8, "0")}1`,
      }));
      const axis = "rowId" in array[0]! ? "rows" : "columns";
      const next = Object.fromEntries(
        normalized.map((entry) => [
          "rowId" in entry ? entry.rowId : entry.columnId,
          entry,
        ]),
      );
      if (!canChangeFixedTextProperty(this.model.yBlock, `prop:${axis}`, next))
        throw new Error("Cannot relocate fixed table text");
      this.model.store.transact(() => {
        if (axis === "rows")
          this.model.props.rows = next as Record<string, TableRow>;
        else this.model.props.columns = next as Record<string, TableColumn>;
      });
      array = normalized;
    }
    after = after != null ? (after < 0 ? undefined : after) : undefined;
    const prevOrder = after == null ? null : array[after]?.order;
    const nextOrder = after == null ? array[0]?.order : array[after + 1]?.order;
    const order = generateFractionalIndexingKeyBetween(
      prevOrder ?? null,
      nextOrder ?? null,
    );
    return order;
  }

  addColumn(after?: number) {
    const order = this.getOrder(this.columns$.value, after);
    const columnId = nanoid();
    this.model.store.transact(() => {
      this.model.props.columns[columnId] = {
        columnId,
        order,
      };
      this.rows$.value.forEach((row) => {
        this.model.props.cells[`${row.rowId}:${columnId}`] = {
          text: new Text(),
        };
      });
    });
    return columnId;
  }

  deleteRow(rowId: string) {
    if (this.readonly$.value || this.hasFixedRow(rowId)) return;
    const rowIndex = this.rows$.value.findIndex((row) => row.rowId === rowId);
    const headerRows = this.headerRows$.value;
    this.model.store.transact(() => {
      Object.keys(this.model.props.rows).forEach((id) => {
        if (id === rowId) {
          delete this.model.props.rows[id];
        }
      });
      Object.keys(this.model.props.cells).forEach((id) => {
        if (id.startsWith(`${rowId}:`)) {
          delete this.model.props.cells[id];
        }
      });
      if (headerRows !== undefined && rowIndex >= 0 && rowIndex < headerRows) {
        this.model.props.headerRows = headerRows - 1;
      }
    });
  }

  deleteColumn(columnId: string) {
    if (this.readonly$.value || this.hasFixedColumn(columnId)) return;
    this.model.store.transact(() => {
      Object.keys(this.model.props.columns).forEach((id) => {
        if (id === columnId) {
          delete this.model.props.columns[id];
        }
      });
      Object.keys(this.model.props.cells).forEach((id) => {
        if (id.endsWith(`:${columnId}`)) {
          delete this.model.props.cells[id];
        }
      });
    });
  }

  updateRowOrder(rowId: string, newOrder: string) {
    if (this.readonly$.value) return false;
    const current = this.model.props.rows[rowId];
    if (
      !current ||
      !canChangeFixedTextProperty(this.model.yBlock, "prop:rows", {
        ...this.model.props.rows,
        [rowId]: { ...current, order: newOrder },
      })
    )
      return false;
    const headerRows = this.headerRows$.value;
    if (headerRows !== undefined) {
      const rows = this.rows$.value
        .map((row) => (row.rowId === rowId ? { ...row, order: newOrder } : row))
        .sort((a, b) => compareTableOrder(a.order, a.rowId, b.order, b.rowId));
      if (rows.slice(0, headerRows).some((row) => row.repeat !== undefined)) {
        return false;
      }
    }
    this.model.store.transact(() => {
      if (this.model.props.rows[rowId]) {
        this.model.props.rows[rowId].order = newOrder;
      }
    });
    return true;
  }

  updateColumnOrder(columnId: string, newOrder: string) {
    if (this.readonly$.value) return;
    const current = this.model.props.columns[columnId];
    if (
      !current ||
      !canChangeFixedTextProperty(this.model.yBlock, "prop:columns", {
        ...this.model.props.columns,
        [columnId]: { ...current, order: newOrder },
      })
    )
      return;
    this.model.store.transact(() => {
      if (this.model.props.columns[columnId]) {
        this.model.props.columns[columnId].order = newOrder;
      }
    });
  }

  setRowBackgroundColor(rowId: string, color?: string) {
    if (this.readonly$.value || this.hasFixedRow(rowId)) return;
    this.model.store.transact(() => {
      if (this.model.props.rows[rowId]) {
        this.model.props.rows[rowId].backgroundColor = color;
      }
    });
  }

  setColumnBackgroundColor(columnId: string, color?: string) {
    if (this.readonly$.value || this.hasFixedColumn(columnId)) return;
    this.model.store.transact(() => {
      if (this.model.props.columns[columnId]) {
        this.model.props.columns[columnId].backgroundColor = color;
      }
    });
  }

  getCellsBySelection(selection: TableAreaSelection): TableCell[] {
    const columns = this.uiColumns$.value.slice(
      selection.columnStartIndex,
      selection.columnEndIndex + 1,
    );
    return this.uiRows$.value
      .slice(selection.rowStartIndex, selection.rowEndIndex + 1)
      .flatMap((row) =>
        columns.flatMap((column) => {
          const cell = this.getCell(row.rowId, column.columnId);
          return cell ? [cell] : [];
        }),
      );
  }

  setCellsBackgroundColor(selection: TableAreaSelection, color?: string) {
    if (this.readonly$.value) return;
    if (
      this.getCellsBySelection(selection).some(
        (cell) => cell.textProtection === "fixed",
      )
    )
      return;
    const cells = this.getCellsBySelection(selection).filter(
      (cell) => cell.backgroundColor !== color,
    );
    if (!cells.length) return;
    this.model.store.captureSync();
    this.model.store.transact(() => {
      for (const cell of cells) {
        if (color === undefined) delete cell.backgroundColor;
        else cell.backgroundColor = color;
      }
    });
    this.model.store.captureSync();
  }

  setColumnTextAlign(columnId: string, textAlign?: TextAlign) {
    if (this.readonly$.value || this.hasFixedColumn(columnId)) return;
    const column = this.model.props.columns[columnId];
    if (this.readonly$.value || !column || column.textAlign === textAlign)
      return;
    this.model.store.captureSync();
    this.model.store.transact(() => {
      if (textAlign === undefined) {
        delete this.model.props.columns[columnId]?.textAlign;
      } else if (this.model.props.columns[columnId]) {
        this.model.props.columns[columnId].textAlign = textAlign;
      }
    });
    this.model.store.captureSync();
  }

  setColumnWidth(columnId: string, width: number) {
    this.model.store.transact(() => {
      if (this.model.props.columns[columnId]) {
        this.model.props.columns[columnId].width = width;
      }
    });
  }

  clearRow(rowId: string) {
    this.clearCells(
      Object.keys(this.model.props.cells)
        .filter((id) => id.startsWith(`${rowId}:`))
        .map((id) => ({ rowId, columnId: id.slice(rowId.length + 1) })),
    );
  }

  clearColumn(columnId: string) {
    this.clearCells(
      Object.keys(this.model.props.cells)
        .filter((id) => id.endsWith(`:${columnId}`))
        .map((id) => ({ rowId: id.slice(0, -columnId.length - 1), columnId })),
    );
  }

  clearCellsBySelection(selection: TableAreaSelection) {
    const columns = this.uiColumns$.value;
    const rows = this.uiRows$.value;
    const deleteCells: { rowId: string; columnId: string }[] = [];
    for (let i = selection.rowStartIndex; i <= selection.rowEndIndex; i++) {
      const row = rows[i];
      if (!row) {
        continue;
      }
      for (
        let j = selection.columnStartIndex;
        j <= selection.columnEndIndex;
        j++
      ) {
        const column = columns[j];
        if (!column) {
          continue;
        }
        deleteCells.push({ rowId: row.rowId, columnId: column.columnId });
      }
    }
    this.clearCells(deleteCells);
  }

  clearCells(cells: { rowId: string; columnId: string }[]) {
    if (this.readonly$.value) return;
    if (
      cells.some(
        ({ rowId, columnId }) =>
          this.getCell(rowId, columnId)?.textProtection === "fixed",
      )
    )
      return;
    this.model.store.captureSync();
    this.model.store.transact(() => {
      cells.forEach(({ rowId, columnId }) => {
        const text = this.model.props.cells[`${rowId}:${columnId}`]?.text;
        if (text) {
          text.replace(0, text.length, "");
        }
      });
    });
    this.model.store.captureSync();
  }

  insertColumn(after?: number) {
    this.addColumn(after);
  }

  insertRow(after?: number) {
    this.addRow(after);
  }

  moveColumn(from: number, after?: number) {
    if (this.readonly$.value) return;
    const columns = this.columns$.value;
    const column = columns[from];
    if (!column) return;
    const order = this.getOrder(columns, after);
    this.updateColumnOrder(column.columnId, order);
  }

  moveRow(from: number, after?: number) {
    if (this.readonly$.value) return false;
    const rows = this.rows$.value;
    const row = rows[from];
    if (!row) return;
    const order = this.getOrder(rows, after);
    return this.updateRowOrder(row.rowId, order);
  }

  duplicateColumn(index: number) {
    const oldColumn = this.columns$.value[index];
    if (!oldColumn) return;
    const order = this.getOrder(this.columns$.value, index);
    const newColumnId = nanoid();
    const fields = new Map<string, string>();
    this.model.store.transact(() => {
      this.model.props.columns[newColumnId] = {
        ...oldColumn,
        columnId: newColumnId,
        order,
      };
      this.rows$.value.forEach((row) => {
        const cell =
          this.model.props.cells[`${row.rowId}:${oldColumn.columnId}`];
        this.model.props.cells[`${row.rowId}:${newColumnId}`] = {
          ...cell,
          text: cell
            ? cloneTextWithDocumentFieldIdentities(cell.text, nanoid, fields)
            : new Text(),
        };
      });
    });
    return newColumnId;
  }

  duplicateRow(index: number) {
    const oldRow = this.rows$.value[index];
    if (!oldRow) return;
    const order = this.getOrder(this.rows$.value, index);
    const headerRows = this.headerRows$.value;
    const insertionIndex = index + 1;
    const newRowId = nanoid();
    const fields = new Map<string, string>();
    this.model.store.transact(() => {
      this.model.props.rows[newRowId] = {
        ...oldRow,
        rowId: newRowId,
        order,
      };
      this.columns$.value.forEach((column) => {
        const cell =
          this.model.props.cells[`${oldRow.rowId}:${column.columnId}`];
        this.model.props.cells[`${newRowId}:${column.columnId}`] = {
          ...cell,
          text: cell
            ? cloneTextWithDocumentFieldIdentities(cell.text, nanoid, fields)
            : new Text(),
        };
      });
      if (headerRows !== undefined && insertionIndex < headerRows) {
        this.model.props.headerRows = headerRows + 1;
      }
    });
    return newRowId;
  }
}
