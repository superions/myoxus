import { CheckboxCell } from "./checkbox/cell-renderer.js";
import { DateCell } from "./date/cell-renderer.js";
import { ImageCell } from "./image/cell-renderer.js";
import { MultiSelectCell } from "./multi-select/cell-renderer.js";
import { NumberCell } from "./number/cell-renderer.js";
import { ProgressCell } from "./progress/cell-renderer.js";
import { SelectCell } from "./select/cell-renderer.js";
import { TextCell } from "./text/cell-renderer.js";

export function propertyPresetsEffects() {
  customElements.define("myoxus-database-checkbox-cell", CheckboxCell);
  customElements.define("myoxus-database-date-cell", DateCell);
  customElements.define("myoxus-database-image-cell", ImageCell);
  customElements.define("myoxus-database-multi-select-cell", MultiSelectCell);
  customElements.define("myoxus-database-number-cell", NumberCell);
  customElements.define("myoxus-database-progress-cell", ProgressCell);
  customElements.define("myoxus-database-select-cell", SelectCell);
  customElements.define("myoxus-database-text-cell", TextCell);
}
