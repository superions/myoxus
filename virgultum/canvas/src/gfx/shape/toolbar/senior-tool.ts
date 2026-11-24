import { editorMessage } from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const shapeSeniorTool = SeniorToolExtension(
  "shape",
  ({ block, toolbarContainer }) => {
    return {
      name: editorMessage("com.myoxus.editor.toolbar.shape", "Shape"),
      content: {
        type: "hosts",
        tags: ["edgeless-shape-tool-button"],
        edgeless: block,
        toolbarContainer,
      },
    };
  },
);
