import { editorMessage } from "@virgultum/shared/services";
import { SeniorToolExtension } from "@virgultum/widget-edgeless-toolbar";
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
