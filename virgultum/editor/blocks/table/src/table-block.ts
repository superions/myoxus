import { signal } from "@preact/signals-core";
import { CaptionedBlockComponent } from "@virgultum/components/caption";
import { IS_MOBILE } from "@virgultum/global/env";
import type { TableBlockModel } from "@virgultum/model";
import { EDGELESS_TOP_CONTENTEDITABLE_SELECTOR } from "@virgultum/shared/consts";
import { DocModeProvider } from "@virgultum/shared/services";
import { VirtualPaddingController } from "@virgultum/shared/utils";
import type { BlockComponent } from "@virgultum/std";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/std/inline";
import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";

import { SelectionController } from "./selection-controller";
import { TableCellPadding } from "./consts";
import {
  rowStyle,
  table,
  tableContainer,
  tableWrapper,
} from "./table-block-css";
import { TableDataManager } from "./table-data-manager";

export const TableBlockComponentName = "myoxus-table";
export class TableBlockComponent extends CaptionedBlockComponent<TableBlockModel> {
  private _dataManager: TableDataManager | null = null;

  get dataManager(): TableDataManager {
    if (!this._dataManager) {
      this._dataManager = new TableDataManager(this.model);
    }
    return this._dataManager;
  }

  selectionController = new SelectionController(this);

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");
    this.style.position = "relative";
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

  override renderBlock() {
    const rows = this.dataManager.uiRows$.value;
    const columns = this.dataManager.uiColumns$.value;
    const headerRows = this.dataManager.headerRows$.value ?? 0;
    const appearance = this.dataManager.appearance$.value ?? "grid";
    const density = this.dataManager.density$.value ?? "normal";
    const cellPadding = TableCellPadding[density];
    const virtualPadding = this.virtualPaddingController.virtualPadding$.value;
    const renderRows = (sectionRows: typeof rows, startIndex: number) =>
      repeat(
        sectionRows,
        (row) => row.rowId,
        (row, sectionRowIndex) => {
          const rowIndex = startIndex + sectionRowIndex;
          return html`
            <tr class=${rowStyle} data-row-id=${row.rowId}>
              ${repeat(
                columns,
                (column) => column.columnId,
                (column, columnIndex) => {
                  const cell = this.dataManager.getCell(
                    row.rowId,
                    column.columnId,
                  );
                  return html`
                    <myoxus-table-cell
                      style="display: contents;"
                      .rowIndex=${rowIndex}
                      .columnIndex=${columnIndex}
                      .isHeader=${rowIndex < headerRows}
                      .row=${row}
                      .column=${column}
                      .text=${cell?.text}
                      .dataManager=${this.dataManager}
                      .selectionController=${this.selectionController}
                    ></myoxus-table-cell>
                  `;
                },
              )}
            </tr>
          `;
        },
      );
    return html`
      <div
        contenteditable="false"
        class=${tableContainer}
        data-table-appearance=${appearance}
        data-table-density=${density}
        style=${styleMap({
          marginLeft: `-${virtualPadding + 10}px`,
          marginRight: `-${virtualPadding}px`,
          position: "relative",
          "--myoxus-table-cell-padding-block": cellPadding.block,
          "--myoxus-table-cell-padding-inline": cellPadding.inline,
        })}
      >
        <div
          style=${styleMap({
            paddingLeft: `${virtualPadding}px`,
            paddingRight: `${virtualPadding}px`,
            marginLeft:
              !this.model.props.textAlign$.value ||
              this.model.props.textAlign$?.value === "left"
                ? undefined
                : "auto",
            marginRight:
              !this.model.props.textAlign$.value ||
              this.model.props.textAlign$?.value === "right"
                ? undefined
                : "auto",
            width: "max-content",
          })}
        >
          <table class=${tableWrapper} ${ref(this.table$)}>
            ${
              headerRows > 0
                ? html`<thead class=${table}>
                    ${renderRows(rows.slice(0, headerRows), 0)}
                  </thead>`
                : nothing
            }
            <tbody class=${table}>
              ${renderRows(rows.slice(headerRows), headerRows)}
            </tbody>
            ${
              IS_MOBILE || this.dataManager.readonly$.value
                ? nothing
                : html`<myoxus-table-add-button
                    style="display: contents;"
                    .dataManager=${this.dataManager}
                  ></myoxus-table-add-button>`
            }
            ${html`<myoxus-table-selection-layer
              style="display: contents;"
              .selectionController=${this.selectionController}
              .getRowRect=${this.getRowRect}
              .getColumnRect=${this.getColumnRect}
              .getAreaRect=${this.getAreaRect}
            ></myoxus-table-selection-layer>`}
          </table>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [TableBlockComponentName]: TableBlockComponent;
  }
}
