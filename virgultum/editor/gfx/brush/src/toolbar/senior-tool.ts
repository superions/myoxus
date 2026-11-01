import { editorMessage } from "@virgultum/shared/services";
import { SeniorToolExtension } from "@virgultum/widget-edgeless-toolbar";
import { html } from "lit";

export const penSeniorTool = SeniorToolExtension("pen", ({ block }) => {
  return {
    name: editorMessage("Pen", "Pen"),
    content: html`<div class="pen-and-eraser">
      <edgeless-pen-tool-button .edgeless=${block}></edgeless-pen-tool-button>

      <edgeless-eraser-tool-button
        .edgeless=${block}
      ></edgeless-eraser-tool-button>
    </div> `,
  };
});
