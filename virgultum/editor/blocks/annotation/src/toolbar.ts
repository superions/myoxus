// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  deleteSelectedModelsCommand,
  duplicateSelectedModelsCommand,
  getSelectedModelsCommand,
} from "@virgultum/shared/commands";
import {
  editorMessage,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/std";

/** Use the standard selection/clipboard lifecycle, including native copy remapping. */
export const annotationToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:annotation"),
  config: {
    when: ({ readonly }) => !readonly,
    actions: [
      {
        id: "duplicate",
        label: editorMessage(
          "com.myoxus.editor.keyboard.duplicate",
          "Duplicate",
        ),
        tooltip: editorMessage(
          "com.myoxus.editor.keyboard.duplicate",
          "Duplicate",
        ),
        icon: "DuplicateIcon",
        run({ chain, store }) {
          if (store.readonly) return;
          store.captureSync();
          chain
            .pipe(getSelectedModelsCommand, { types: ["block"] })
            .pipe(duplicateSelectedModelsCommand)
            .run();
        },
      },
      {
        id: "delete",
        label: editorMessage("Delete", "Delete"),
        tooltip: editorMessage("Delete", "Delete"),
        icon: "DeleteIcon",
        variant: "destructive",
        run({ chain, store }) {
          if (store.readonly) return;
          store.captureSync();
          chain
            .pipe(getSelectedModelsCommand, { types: ["block"] })
            .pipe(deleteSelectedModelsCommand)
            .run();
          store.captureSync();
        },
      },
    ],
  },
});
