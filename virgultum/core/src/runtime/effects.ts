import { registerGfxViewportElement } from "./gfx/native-viewport.js";
import { VElement, VLine, VText } from "./inline/index.js";
import { EditorHost } from "./view/index.js";

export function effects() {
  // editor host
  customElements.define("editor-host", EditorHost);
  // gfx
  registerGfxViewportElement();
  // inline
  customElements.define("v-element", VElement);
  customElements.define("v-line", VLine);
  customElements.define("v-text", VText);
}
