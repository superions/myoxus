import { editorMessage } from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";
import { html } from "lit";

export const shapeSeniorTool = SeniorToolExtension(
  "shape",
  ({ block, toolbarContainer }) => {
    return {
      name: editorMessage("com.myoxus.editor.toolbar.shape", "Shape"),
      content: html`<edgeless-shape-tool-button
        .edgeless=${block}
        .toolbarContainer=${toolbarContainer}
      ></edgeless-shape-tool-button>`,
    };
  },
);
