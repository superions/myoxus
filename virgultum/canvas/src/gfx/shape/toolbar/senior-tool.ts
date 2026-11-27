import { editorMessage } from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const shapeSeniorTool = SeniorToolExtension("shape", ({ block }) => {
  return {
    name: editorMessage("com.myoxus.editor.toolbar.shape", "Shape"),
    content: {
      type: "popover-tool",
      tool: "shape",
      edgeless: block,
    },
  };
});
