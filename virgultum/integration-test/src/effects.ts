import "@virgultum/editor/effects";

import { TestMyoxusEditorContainer } from "./editors/index.js";

export function effects() {
  customElements.define("myoxus-editor-container", TestMyoxusEditorContainer);
}
