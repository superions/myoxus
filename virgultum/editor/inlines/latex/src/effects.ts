import { LatexSourceEditor } from "./latex-node/latex-source-editor";
import { LatexEditorUnit } from "./latex-node/latex-editor-unit";
import { MyoxusLatexNode } from "./latex-node/latex-node";

export function effects() {
  customElements.define("latex-source-editor", LatexSourceEditor);
  customElements.define("latex-editor-unit", LatexEditorUnit);
  customElements.define("myoxus-latex-node", MyoxusLatexNode);
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-latex-node": MyoxusLatexNode;
    "latex-editor-unit": LatexEditorUnit;
    "latex-source-editor": LatexSourceEditor;
  }
}
