import { editorMessage } from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const templateSeniorTool = SeniorToolExtension(
  "template",
  ({ block }) => {
    return {
      name: editorMessage("Template", "Template"),
      content: {
        type: "hosts",
        tags: ["edgeless-template-button"],
        edgeless: block,
      },
    };
  },
);
