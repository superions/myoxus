import { AddButton, AddButtonComponentName } from "./add-button";
import { TableBlockComponent, TableBlockComponentName } from "./table-block";
import { TableCell, TableCellComponentName } from "./table-cell";

export function effects() {
  customElements.define(TableBlockComponentName, TableBlockComponent);
  customElements.define(TableCellComponentName, TableCell);
  customElements.define(AddButtonComponentName, AddButton);
}
