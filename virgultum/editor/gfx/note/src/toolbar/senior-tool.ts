import { editorMessage } from "@virgultum/shared/services";
import { SeniorToolExtension } from "@virgultum/widget-edgeless-toolbar";
import { html } from "lit";

export const noteSeniorTool = SeniorToolExtension("note", ({ block }) => {
  return {
    name: editorMessage("com.myoxus.editor.callout.note", "Note"),
    content: html`<edgeless-note-senior-button
      .edgeless=${block}
    ></edgeless-note-senior-button>`,
  };
});
