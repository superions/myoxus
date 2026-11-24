import { editorMessage } from "@virgultum/core/services";
import { SeniorToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const noteSeniorTool = SeniorToolExtension("note", ({ block }) => {
  return {
    name: editorMessage("com.myoxus.editor.callout.note", "Note"),
    content: {
      type: "hosts",
      tags: ["edgeless-note-senior-button"],
      edgeless: block,
    },
  };
});
