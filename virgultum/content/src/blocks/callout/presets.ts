// SPDX-License-Identifier: AGPL-3.0-or-later
import { editorMessage } from "@virgultum/core/services";

/** One preset list for insertion and changes to an existing callout's type. */
export const calloutPresets = [
  {
    type: "note",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.note",
      "Callout: Note",
    ),
  },
  {
    type: "abstract",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.abstract",
      "Callout: Abstract",
    ),
  },
  {
    type: "info",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.info",
      "Callout: Info",
    ),
  },
  {
    type: "todo",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.todo",
      "Callout: Todo",
    ),
  },
  {
    type: "tip",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.tip",
      "Callout: Tip",
    ),
  },
  {
    type: "success",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.success",
      "Callout: Success",
    ),
  },
  {
    type: "question",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.question",
      "Callout: Question",
    ),
  },
  {
    type: "warning",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.warning",
      "Callout: Warning",
    ),
  },
  {
    type: "failure",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.failure",
      "Callout: Failure",
    ),
  },
  {
    type: "danger",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.danger",
      "Callout: Danger",
    ),
  },
  {
    type: "bug",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.bug",
      "Callout: Bug",
    ),
  },
  {
    type: "example",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.example",
      "Callout: Example",
    ),
  },
  {
    type: "quote",
    label: editorMessage(
      "com.myoxus.editor.callout.preset.quote",
      "Callout: Quote",
    ),
  },
] as const;
