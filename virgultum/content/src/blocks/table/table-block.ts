import { effect, signal, untracked } from "@preact/signals-core";
import { IS_MOBILE } from "@virgultum/core/primitives/env";
import type { TableBlockModel } from "@virgultum/core/models";
import { EDGELESS_TOP_CONTENTEDITABLE_SELECTOR } from "@virgultum/core/consts";
import { DocModeProvider } from "@virgultum/core/services";
import { VirtualPaddingController } from "@virgultum/core/utils";
import {
  blockVersionWarning,
  NativeBlockComponent,
  type BlockComponent,
} from "@virgultum/core/runtime";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/core/runtime/inline";

import { selectionFrame } from "../../caption/selection-frame";
import { AddButtonComponentName, type AddButton } from "./add-button";
import { SelectionController } from "./selection-controller";
import { TableCellPadding } from "./consts";
import {
  rowStyle,
  table,
  tableContainer,
  tableWrapper,
} from "./table-block-css";
import { TableCellComponentName, type TableCell } from "./table-cell";
import { TableDataManager } from "./table-data-manager";

export const TableBlockComponentName = "myoxus-table";

export class TableBlockComponent extends NativeBlockComponent<TableBlockModel> {
  private _dataManager: TableDataManager | null = null;
  private readonly revision = signal(0);

  get dataManager(): TableDataManager {
    if (!this._dataManager) {
      this._dataManager = new TableDataManager(this.model);
    }
    return this._dataManager;
  }

  selectionController = new SelectionController(this);

  override get updateComplete() {
    return Promise.resolve(this.isConnected);
  }

  override requestUpdate() {
    this.revision.value++;
  }

  connectedCallback() {
    if (!this.connectBlock()) return;
    if (this.viewType === "hidden") return;
    if (this.isVersionMismatch) {
      this.replaceChildren(blockVersionWarning(this.ownerDocument, this.model));
      return;
    }

    this.selectionController.connect();
    this.virtualPaddingController.connect();
    this.observeSelection();
    this.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
    this.style.position = "relative";

    const doc = this.ownerDocument;
    const container = doc.createElement("div");
    container.contentEditable = "false";
    container.className = tableContainer;
    container.style.position = "relative";

    const inner = doc.createElement("div");
    inner.style.width = "max-content";

    const tableEl = doc.createElement("table");
    tableEl.className = tableWrapper;

    const thead = doc.createElement("thead");
    thead.className = table;
    const tbody = doc.createElement("tbody");
    tbody.className = table;

    tableEl.append(tbody);
    inner.append(tableEl);
    container.append(inner);

    const frame = selectionFrame(this, container);
    this.replaceChildren(frame);
    this.table$.value = tableEl;

    if (
      this.closest("myoxus-note, myoxus-edgeless-note")?.localName ===
      "myoxus-edgeless-note"
    ) {
      this.observeCanvasTable();
    }

    this.disposables.add(
      this.model.propsUpdated.subscribe(() => {
        this.requestUpdate();
      }),
    );

    this.disposables.add(
      effect(() => {
        void this.revision.value;
        const appearance = this.dataManager.appearance$.value ?? "grid";
        const density = this.dataManager.density$.value ?? "normal";
        const cellPadding = TableCellPadding[density];
        const virtualPadding =
          this.virtualPaddingController.virtualPadding$.value;
        const textAlign = this.model.props.textAlign$?.value;

        container.dataset.tableAppearance = appearance;
        container.dataset.tableDensity = density;
        container.style.marginLeft = `-${virtualPadding + 10}px`;
        container.style.marginRight = `-${virtualPadding}px`;
        container.style.setProperty(
          "--myoxus-table-cell-padding-block",
          cellPadding.block,
        );
        container.style.setProperty(
          "--myoxus-table-cell-padding-inline",
          cellPadding.inline,
        );

        inner.style.paddingLeft = `${virtualPadding}px`;
        inner.style.paddingRight = `${virtualPadding}px`;
        inner.style.marginLeft =
          !textAlign || textAlign === "left" ? "" : "auto";
        inner.style.marginRight =
          !textAlign || textAlign === "right" ? "" : "auto";
      }),
    );

    const rowViews = new Map<
      string,
      { tr: HTMLTableRowElement; cells: Map<string, TableCell> }
    >();
    let addButton: AddButton | null = null;

    this.disposables.add(
      effect(() => {
        void this.revision.value;
        const rows = this.dataManager.uiRows$.value;
        const columns = this.dataManager.uiColumns$.value;
        const headerRows = this.dataManager.headerRows$.value ?? 0;
        const readonly = this.dataManager.readonly$.value;
        // Subscribe to cell map mutations so cell creation/color/protection propagates.
        void this.model.props.cells$.value;

        untracked(() => {
          const activeRowIds = new Set<string>();
          const syncSection = (
            section: HTMLTableSectionElement,
            sectionRows: typeof rows,
            startIndex: number,
          ) => {
            const orderedRows: HTMLTableRowElement[] = [];
            sectionRows.forEach((row) => {
              activeRowIds.add(row.rowId);
              let entry = rowViews.get(row.rowId);
              if (!entry) {
                const tr = doc.createElement("tr");
                tr.className = rowStyle;
                tr.dataset.rowId = row.rowId;
                entry = { tr, cells: new Map() };
                rowViews.set(row.rowId, entry);
              }
              orderedRows.push(entry.tr);
            });
            orderedRows.forEach((tr, index) => {
              const current = section.children.item(index);
              if (tr !== current) section.insertBefore(tr, current);
            });
            sectionRows.forEach((row, sectionRowIndex) => {
              const rowIndex = startIndex + sectionRowIndex;
              const entry = rowViews.get(row.rowId)!;
              const activeColIds = new Set<string>();
              const orderedCells: TableCell[] = [];
              columns.forEach((column, columnIndex) => {
                activeColIds.add(column.columnId);
                const cellData = this.dataManager.getCell(
                  row.rowId,
                  column.columnId,
                );
                let cellEl = entry.cells.get(column.columnId);
                if (!cellEl) {
                  cellEl = doc.createElement(
                    TableCellComponentName,
                  ) as TableCell;
                  cellEl.style.display = "contents";
                  cellEl.dataManager = this.dataManager;
                  cellEl.selectionController = this.selectionController;
                  entry.cells.set(column.columnId, cellEl);
                }
                cellEl.rowIndex = rowIndex;
                cellEl.columnIndex = columnIndex;
                cellEl.isHeader = rowIndex < headerRows;
                cellEl.row = row as TableCell["row"];
                cellEl.column = column as TableCell["column"];
                cellEl.text = cellData?.text;
                cellEl.notifyModelUpdate();
                orderedCells.push(cellEl);
              });
              for (const [colId, cellEl] of entry.cells) {
                if (!activeColIds.has(colId)) {
                  cellEl.remove();
                  entry.cells.delete(colId);
                }
              }
              orderedCells.forEach((cellEl, index) => {
                const current = entry.tr.children.item(index);
                if (cellEl !== current) entry.tr.insertBefore(cellEl, current);
              });
            });
          };

          if (headerRows > 0) {
            if (!thead.parentNode) tableEl.insertBefore(thead, tbody);
            syncSection(thead, rows.slice(0, headerRows), 0);
          } else if (thead.parentNode) {
            thead.remove();
          }

          syncSection(tbody, rows.slice(headerRows), headerRows);

          for (const [rowId, entry] of rowViews) {
            if (!activeRowIds.has(rowId)) {
              entry.tr.remove();
              rowViews.delete(rowId);
            }
          }

          if (IS_MOBILE || readonly) {
            if (addButton) {
              addButton.remove();
              addButton = null;
            }
          } else if (!addButton) {
            addButton = doc.createElement(AddButtonComponentName) as AddButton;
            addButton.style.display = "contents";
            addButton.dataManager = this.dataManager;
            tableEl.append(addButton);
          }
        });
      }),
    );
  }

  override disconnectedCallback() {
    this.table$.value = undefined;
    super.disconnectedCallback();
    this.replaceChildren();
  }

  private observeCanvasTable() {
    this.disposables.add(
      effect(() => {
        const table = this.table$.value;
        const layout = table?.parentElement;
        const scroller = layout?.parentElement;
        if (!table || !layout || !scroller) return;
        layout.setAttribute("data-edgeless-table-layout", "");

        let frame = 0;
        const observer = new ResizeObserver(() => {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (!table.offsetWidth) return;
            const available =
              scroller.clientWidth -
              parseFloat(getComputedStyle(scroller).paddingLeft);
            // Measure in layout pixels, independently of the canvas camera. At
            // the legibility floor, the remaining columns use native scrolling.
            const scale = Math.max(
              0.8,
              Math.min(1, available / table.offsetWidth),
            );
            layout.style.setProperty(
              "--virgultum-table-fit-scale",
              String(scale),
            );
          });
        });
        observer.observe(scroller);
        observer.observe(table);

        const onWheel = (event: WheelEvent) => {
          if (event.ctrlKey || event.metaKey) return;
          const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
          if (
            !delta ||
            (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(delta))
          )
            return;
          if (
            delta < 0
              ? scroller.scrollLeft > 0
              : scroller.scrollLeft + scroller.clientWidth <
                scroller.scrollWidth - 1
          ) {
            event.stopPropagation();
          }
        };
        scroller.addEventListener("wheel", onWheel, { passive: true });
        return () => {
          scroller.removeEventListener("wheel", onWheel);
          cancelAnimationFrame(frame);
          observer.disconnect();
          layout.removeAttribute("data-edgeless-table-layout");
          layout.style.removeProperty("--virgultum-table-fit-scale");
        };
      }),
    );
  }

  override get topContenteditableElement() {
    if (this.std.get(DocModeProvider).getEditorMode() === "edgeless") {
      return this.closest<BlockComponent>(
        EDGELESS_TOP_CONTENTEDITABLE_SELECTOR,
      );
    }
    return this.rootComponent;
  }

  private readonly virtualPaddingController: VirtualPaddingController =
    new VirtualPaddingController(this);

  table$ = signal<HTMLTableElement>();

  public getScale(): number {
    const table = this.table$.value;
    if (!table) return 1;
    return table.getBoundingClientRect().width / table.offsetWidth;
  }

  private readonly getRootRect = () => {
    const table = this.table$.value;
    if (!table) return;
    return table.getBoundingClientRect();
  };

  private readonly getRowRect = (rowId: string) => {
    const row = this.querySelector(`tr[data-row-id="${rowId}"]`);
    const rootRect = this.getRootRect();
    if (!row || !rootRect) return;
    const rect = row.getBoundingClientRect();
    const scale = this.getScale();
    return {
      top: (rect.top - rootRect.top) / scale,
      left: (rect.left - rootRect.left) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    };
  };

  private readonly getColumnRect = (columnId: string) => {
    const columns = this.querySelectorAll(
      `[data-table-cell][data-column-id="${columnId}"]`,
    );
    const rootRect = this.getRootRect();
    if (!rootRect) return;
    const firstRect = columns.item(0)?.getBoundingClientRect();
    const lastRect = columns.item(columns.length - 1)?.getBoundingClientRect();
    if (!firstRect || !lastRect) return;
    const scale = this.getScale();
    return {
      top: (firstRect.top - rootRect.top) / scale,
      left: (firstRect.left - rootRect.left) / scale,
      width: firstRect.width / scale,
      height: (lastRect.bottom - firstRect.top) / scale,
    };
  };

  private readonly getAreaRect = (
    rowStartIndex: number,
    rowEndIndex: number,
    columnStartIndex: number,
    columnEndIndex: number,
  ) => {
    const rootRect = this.getRootRect();
    const rows = this.querySelectorAll("tr");
    const startRow = rows.item(rowStartIndex);
    const endRow = rows.item(rowEndIndex);
    if (!startRow || !endRow || !rootRect) return;

    const startCells = startRow.querySelectorAll("[data-table-cell]");
    const endCells = endRow.querySelectorAll("[data-table-cell]");
    const startCell = startCells.item(columnStartIndex);
    const endCell = endCells.item(columnEndIndex);
    if (!startCell || !endCell) return;

    const startRect = startCell.getBoundingClientRect();
    const endRect = endCell.getBoundingClientRect();
    const scale = this.getScale();

    return {
      top: (startRect.top - rootRect.top) / scale,
      left: (startRect.left - rootRect.left) / scale,
      width: (endRect.right - startRect.left) / scale,
      height: (endRect.bottom - startRect.top) / scale,
    };
  };

  private observeSelection() {
    this.disposables.add(
      effect(() => {
        const table = this.table$.value;
        if (!table) return;
        // Measure inside the table so Canvas scaling and horizontal scrolling
        // affect the outline and its selected cells together.
        const outline = table.ownerDocument.createElement("div");
        outline.dataset.tableSelectionOutline = "";
        outline.style.cssText =
          "position:absolute;pointer-events:none;border-radius:2px;border:2px solid var(--myoxus-primary-color)";
        table.append(outline);
        const paint = () => {
          const selected = this.selectionController.selected$.value;
          const rect = !selected
            ? undefined
            : selected.type === "row"
              ? this.getRowRect(selected.rowId)
              : selected.type === "column"
                ? this.getColumnRect(selected.columnId)
                : this.getAreaRect(
                    selected.rowStartIndex,
                    selected.rowEndIndex,
                    selected.columnStartIndex,
                    selected.columnEndIndex,
                  );
          outline.hidden = !rect;
          if (!rect) return;
          Object.assign(outline.style, {
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          });
        };
        const stop = effect(paint);
        const observer = new ResizeObserver(paint);
        observer.observe(table);
        return () => {
          observer.disconnect();
          stop();
          outline.remove();
        };
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [TableBlockComponentName]: TableBlockComponent;
  }
}
