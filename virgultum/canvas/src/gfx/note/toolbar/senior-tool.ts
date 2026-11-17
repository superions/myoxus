import { editorMessage } from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";
import { html } from "lit";

export const noteSeniorTool = SeniorToolExtension("note", ({ block }) => {
  return {
    name: editorMessage("com.myoxus.editor.callout.note", "Note"),
    content: html`<edgeless-note-senior-button
      .edgeless=${block}
    ></edgeless-note-senior-button>`,
  };
});
