import {
  editorMessage,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";
import { html } from "lit";

export const penSeniorTool = SeniorToolExtension("pen", ({ block }) => {
  return {
    name: editorMessage("Pen", "Pen"),
    content: block.std
      .get(EditorChromeHostIdentifier)
      .renderCanvasToolGroup([
        html`<edgeless-pen-tool-button
          .edgeless=${block}
        ></edgeless-pen-tool-button>`,
        html`<edgeless-eraser-tool-button
          .edgeless=${block}
        ></edgeless-eraser-tool-button>`,
      ]),
  };
});
