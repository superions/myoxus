import { editorMessage } from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const penSeniorTool = SeniorToolExtension("pen", ({ block }) => {
  return {
    name: editorMessage("Pen", "Pen"),
    content: {
      type: "hosts",
      tags: ["edgeless-pen-tool-button", "edgeless-eraser-tool-button"],
      edgeless: block,
    },
  };
});
