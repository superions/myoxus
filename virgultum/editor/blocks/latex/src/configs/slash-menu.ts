import { insertInlineLatex } from "@virgultum/inline-latex";
import {
  getSelectedModelsCommand,
  getTextSelectionCommand,
} from "@virgultum/shared/commands";
import { editorMessage } from "@virgultum/shared/services";
import { type SlashMenuConfig } from "@virgultum/widget-slash-menu";

import { insertLatexBlockCommand } from "../commands";

export const latexSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-inline-equation-insert",
      label: editorMessage(
        "com.myoxus.editor.slash.inline-equation",
        "Inline equation",
      ),
      group: {
        id: "basic",
        label: editorMessage("com.myoxus.editor.group.basic", "Basic"),
        order: 0,
        itemOrder: 8,
      },
      description: editorMessage(
        "com.myoxus.editor.slash.inline-equation-description",
        "Create an inline equation.",
      ),
      icon: "TeXIcon",
      tooltip: {
        caption: editorMessage(
          "com.myoxus.editor.slash.inline-equation",
          "Inline equation",
        ),
      },
      searchAlias: [
        editorMessage(
          "com.myoxus.editor.slash.inline-equation",
          "Inline equation",
        ),
      ],
      action: ({ std }) => {
        std.command
          .chain()
          .pipe(getTextSelectionCommand)
          .pipe(insertInlineLatex)
          .run();
      },
    },
    {
      id: "block-equation-insert",
      label: editorMessage("com.myoxus.editor.slash.equation", "Equation"),
      description: editorMessage(
        "com.myoxus.editor.slash.equation-description",
        "Create an equation block.",
      ),
      icon: "TeXIcon",
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.equation", "Equation"),
      },
      searchAlias: [
        editorMessage("com.myoxus.editor.slash.equation-alias", "equation"),
      ],
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 10,
      },
      action: ({ std }) => {
        std.command
          .chain()
          .pipe(getSelectedModelsCommand)
          .pipe(insertLatexBlockCommand, {
            place: "after",
            removeEmptyLine: true,
          })
          .run();
      },
    },
  ],
};
