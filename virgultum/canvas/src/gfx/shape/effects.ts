import {
  EdgelessShapeMenu,
  EdgelessShapeToolButton,
  EdgelessToolbarShapeDraggable,
} from "./draggable";
import { EdgelessShapeTextEditor } from "./text/edgeless-shape-text-editor";

export function effects() {
  customElements.define("edgeless-shape-text-editor", EdgelessShapeTextEditor);
  customElements.define("edgeless-shape-menu", EdgelessShapeMenu);
  customElements.define("edgeless-shape-tool-button", EdgelessShapeToolButton);
  customElements.define(
    "edgeless-toolbar-shape-draggable",
    EdgelessToolbarShapeDraggable,
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-shape-text-editor": EdgelessShapeTextEditor;
    "edgeless-shape-menu": EdgelessShapeMenu;
    "edgeless-toolbar-shape-draggable": EdgelessToolbarShapeDraggable;
    "edgeless-shape-tool-button": EdgelessShapeToolButton;
  }
}
