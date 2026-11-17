import { editorMessage } from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";
import { html } from "lit";

export const templateSeniorTool = SeniorToolExtension(
  "template",
  ({ block }) => {
    return {
      name: editorMessage("Template", "Template"),
      content: html`<edgeless-template-button .edgeless=${block}>
      </edgeless-template-button>`,
    };
  },
);
