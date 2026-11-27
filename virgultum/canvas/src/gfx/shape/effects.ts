import { EdgelessShapeTextEditor } from "./text/edgeless-shape-text-editor";

export function effects() {
  customElements.define("edgeless-shape-text-editor", EdgelessShapeTextEditor);
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-shape-text-editor": EdgelessShapeTextEditor;
  }
}
