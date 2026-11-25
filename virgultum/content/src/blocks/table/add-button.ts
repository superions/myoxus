import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  type EditorTableControl,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { computed, effect, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/runtime";

import {
  addColumnButtonStyle,
  addRowButtonStyle,
  addRowColumnButtonStyle,
} from "./add-button-css";
import type { TableBlockComponent } from "./table-block";
import { DefaultColumnWidth, DefaultRowHeight } from "./consts";
import type { TableDataManager } from "./table-data-manager";

export const AddButtonComponentName = "myoxus-table-add-button";
export class AddButton extends NativeViewElement {
  disposables = new DisposableGroup();

  vertical = false;

  dataManager!: TableDataManager;

  get hoverColumnIndex$() {
    return this.dataManager.hoverColumnIndex$;
  }

  get hoverRowIndex$() {
    return this.dataManager.hoverRowIndex$;
  }

  get columns$() {
    return this.dataManager.columns$;
  }

  get rows$() {
    return this.dataManager.rows$;
  }

  private suppressDragClick = false;
  private dragAbortController: AbortController | null = null;

  columnDragging$ = signal(false);
  rowDragging$ = signal(false);
  rowColumnDragging$ = signal(false);

  getEmptyRows() {
    const rows = this.rows$.value;
    const columns = this.columns$.value;
    const rowWidths: number[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row) {
        break;
      }
      const hasText = columns.some((column) => {
        const cell = this.dataManager.getCell(row.rowId, column.columnId);
        if (!cell) {
          return false;
        }
        return cell.text.length > 0;
      });
      if (hasText) {
        break;
      }
      rowWidths.push((rowWidths[rowWidths.length - 1] ?? 0) + DefaultRowHeight);
    }
    return rowWidths;
  }

  getEmptyColumns() {
    const columns = this.columns$.value;
    const rows = this.rows$.value;
    const columnWidths: number[] = [];
    for (let i = columns.length - 1; i >= 0; i--) {
      const column = columns[i];
      if (!column) {
        break;
      }
      const hasText = rows.some((row) => {
        const cell = this.dataManager.getCell(row.rowId, column.columnId);
        if (!cell) {
          return false;
        }
        return cell.text.length > 0;
      });
      if (hasText) {
        break;
      }
      columnWidths.push(
        (columnWidths[columnWidths.length - 1] ?? 0) +
          (column.width ?? DefaultColumnWidth),
      );
    }
    return columnWidths;
  }

  onDragStart(e: MouseEvent) {
    if (this.dataManager.readonly$.value || e.button !== 0) return;
    e.stopPropagation();
    this.suppressDragClick = false;
    const initialX = e.clientX;
    const initialY = e.clientY;
    const target = e.target as HTMLElement;
    const isColumn = target.closest(".column-add");
    const isRow = target.closest(".row-add");
    const isRowColumn = target.closest(".row-column-add");
    const realTarget = isColumn || isRowColumn || isRow;
    if (!realTarget) {
      return;
    }
    let emptyRows: number[] = [];
    let emptyColumns: number[] = [];
    if (isColumn) {
      this.columnDragging$.value = true;
      emptyColumns = this.getEmptyColumns();
    }
    if (isRow) {
      this.rowDragging$.value = true;
      emptyRows = this.getEmptyRows();
    }
    if (isRowColumn) {
      this.rowColumnDragging$.value = true;
      emptyRows = this.getEmptyRows();
      emptyColumns = this.getEmptyColumns();
    }
    const onMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - initialX;
      const deltaY = e.clientY - initialY;
      const addColumn = isColumn || isRowColumn;
      const addRow = isRow || isRowColumn;
      if (addColumn) {
        if (deltaX > 0) {
          this.dataManager.virtualColumnCount$.value = Math.floor(
            (deltaX + 30) / DefaultColumnWidth,
          );
        } else {
          let count = 0;
          while (count < emptyColumns.length) {
            const emptyColumnWidth = emptyColumns[count];
            if (!emptyColumnWidth) {
              continue;
            }
            if (-deltaX > emptyColumnWidth) {
              count++;
            } else {
              break;
            }
          }
          this.dataManager.virtualColumnCount$.value = -count;
        }
      }
      if (addRow) {
        if (deltaY > 0) {
          this.dataManager.virtualRowCount$.value = Math.floor(
            deltaY / DefaultRowHeight,
          );
        } else {
          let count = 0;
          while (count < emptyRows.length) {
            const emptyRowHeight = emptyRows[count];
            if (!emptyRowHeight) {
              continue;
            }
            if (-deltaY > emptyRowHeight) {
              count++;
            } else {
              break;
            }
          }
          this.dataManager.virtualRowCount$.value = -count;
        }
      }
    };
    this.dragAbortController?.abort();
    const abortController = new AbortController();
    this.dragAbortController = abortController;
    const onMouseUp = () => {
      abortController.abort();
      if (this.dragAbortController === abortController) {
        this.dragAbortController = null;
      }
      this.columnDragging$.value = false;
      this.rowDragging$.value = false;
      this.rowColumnDragging$.value = false;
      const rowCount = this.dataManager.virtualRowCount$.value;
      const columnCount = this.dataManager.virtualColumnCount$.value;
      // A browser may synthesize a click after releasing on the growing edge.
      this.suppressDragClick = rowCount !== 0 || columnCount !== 0;
      this.dataManager.virtualColumnCount$.value = 0;
      this.dataManager.virtualRowCount$.value = 0;
      if (this.isConnected) {
        this.dataManager.addNRow(rowCount);
        this.dataManager.addNColumn(columnCount);
      }
    };
    window.addEventListener("mousemove", onMouseMove, {
      signal: abortController.signal,
    });
    window.addEventListener("mouseup", onMouseUp, {
      signal: abortController.signal,
    });
    window.addEventListener("blur", onMouseUp, {
      signal: abortController.signal,
    });
  }

  private createControlState(kind: "column" | "row" | "row-column") {
    return computed<EditorTableControl | null>(() => {
      const table = this.closest<TableBlockComponent>("myoxus-table");
      const i18n = table?.std.getOptional(EditorI18nProvider) ?? undefined;
      const column = kind !== "row";
      const row = kind !== "column";
      const dragging =
        kind === "column"
          ? this.columnDragging$.value
          : kind === "row"
            ? this.rowDragging$.value
            : this.rowColumnDragging$.value;
      const rowLabel = resolveEditorMessage(
        editorMessage("com.myoxus.editor.table.insert-below", "Insert below"),
        i18n,
      );
      const columnLabel = resolveEditorMessage(
        editorMessage("com.myoxus.editor.table.insert-right", "Insert right"),
        i18n,
      );
      return {
        dragBadge: dragging
          ? this.dataManager.cellCountTips$.value || undefined
          : undefined,
        action: {
          id: `add-${kind}-button`,
          icon: "PlusIcon",
          label:
            row && column
              ? `${rowLabel} / ${columnLabel}`
              : row
                ? rowLabel
                : columnLabel,
          disabled: this.dataManager.readonly$.value,
          run: (_element, event) => this.add(kind, event),
        },
      };
    });
  }

  connectedCallback(): void {
    this.disposables = new DisposableGroup();
    const doc = this.ownerDocument;
    const table = this.closest<TableBlockComponent>("myoxus-table");
    const chrome = table?.std.getOptional(EditorChromeHostIdentifier);

    const colEdge = doc.createElement("div");
    colEdge.className = `${addColumnButtonStyle} column-add`;
    const rowEdge = doc.createElement("div");
    rowEdge.className = `${addRowButtonStyle} row-add`;
    const cornerEdge = doc.createElement("div");
    cornerEdge.className = `${addRowColumnButtonStyle} row-column-add`;

    this.replaceChildren(colEdge, rowEdge, cornerEdge);

    if (chrome) {
      this.disposables.add(
        chrome.mountTableControl(colEdge, this.createControlState("column")),
      );
      this.disposables.add(
        chrome.mountTableControl(rowEdge, this.createControlState("row")),
      );
      this.disposables.add(
        chrome.mountTableControl(
          cornerEdge,
          this.createControlState("row-column"),
        ),
      );
    }

    this.disposables.add(
      effect(() => {
        const colHovered =
          this.hoverColumnIndex$.value === this.columns$.value.length - 1;
        const colDragging = this.columnDragging$.value;
        colEdge.classList.toggle("active", colDragging);
        colEdge.style.opacity = colHovered || colDragging ? "1" : "";

        const rowHovered =
          this.hoverRowIndex$.value === this.rows$.value.length - 1;
        const rowDragging = this.rowDragging$.value;
        rowEdge.classList.toggle("active", rowDragging);
        rowEdge.style.opacity = rowHovered || rowDragging ? "1" : "";

        const cornerHovered = rowHovered && colHovered;
        const cornerDragging = this.rowColumnDragging$.value;
        cornerEdge.classList.toggle("active", cornerDragging);
        cornerEdge.style.opacity = cornerHovered || cornerDragging ? "1" : "";
      }),
    );

    this.disposables.addFromEvent(this, "mousedown", (e: MouseEvent) => {
      this.onDragStart(e);
    });
    this.disposables.addFromEvent(this, "click", (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest("button")) return;
      const edge = target.closest(".column-add, .row-add, .row-column-add");
      if (!edge) return;
      event.preventDefault();
      event.stopPropagation();
      this.add(
        edge.classList.contains("column-add")
          ? "column"
          : edge.classList.contains("row-add")
            ? "row"
            : "row-column",
        event,
      );
    });
  }

  disconnectedCallback(): void {
    this.dragAbortController?.abort();
    this.dragAbortController = null;
    this.disposables.dispose();
    this.replaceChildren();
  }

  private add(kind: "column" | "row" | "row-column", event: MouseEvent) {
    const suppress = this.suppressDragClick && event.detail > 0;
    this.suppressDragClick = false;
    if (suppress || !this.isConnected || this.dataManager.readonly$.value)
      return;
    if (kind !== "column") this.dataManager.addRow(this.rows$.value.length - 1);
    if (kind !== "row")
      this.dataManager.addColumn(this.columns$.value.length - 1);
  }
}
declare global {
  interface HTMLElementTagNameMap {
    [AddButtonComponentName]: AddButton;
  }
}
