import { EdgelessTemplatePanel } from "./toolbar/template-panel";
import { EdgelessTemplateButton } from "./toolbar/template-tool-button";

export function effects() {
  customElements.define("edgeless-templates-panel", EdgelessTemplatePanel);
  customElements.define("edgeless-template-button", EdgelessTemplateButton);
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-templates-panel": EdgelessTemplatePanel;
    "edgeless-template-button": EdgelessTemplateButton;
  }
}
