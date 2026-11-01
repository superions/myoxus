import { effect } from "@preact/signals-core";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { cssVar } from "@virgultum/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { property } from "lit/decorators.js";
import { html } from "lit/static-html.js";

import type { VirtualTableViewUILogic } from "../table-view-ui-logic.js";
import type { TableGridCell } from "../types.js";
import * as styles from "./row-header-css.js";

export class TableRowLast extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  get rowSelected$() {
    return this.gridCell.row.data.selected$;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    const style = this.parentElement?.style;
    if (style) {
      style.borderBottom = `1px solid ${cssVar("borderColor")}`;
    }
    this.disposables.add(
      effect(() => {
        const rowSelected = this.rowSelected$.value;
        if (rowSelected) {
          this.parentElement?.classList.add(styles.rowSelectedBg);
        } else {
          this.parentElement?.classList.remove(styles.rowSelectedBg);
        }
      }),
    );
    this.disposables.addFromEvent(this.parentElement, "mouseenter", () => {
      this.gridCell.data.hover$.value = true;
    });
    this.disposables.addFromEvent(this.parentElement, "mouseleave", () => {
      this.gridCell.data.hover$.value = false;
    });
  }

  protected override render() {
    return html``;
  }

  get rowId() {
    return this.gridCell.row.rowId;
  }

  get groupKey() {
    return this.gridCell.row.group.groupId;
  }

  @property({ attribute: false })
  accessor gridCell!: TableGridCell;

  @property({ attribute: false })
  accessor tableViewLogic!: VirtualTableViewUILogic;
}

declare global {
  interface HTMLElementTagNameMap {
    "data-view-table-row-last": TableRowLast;
  }
}
