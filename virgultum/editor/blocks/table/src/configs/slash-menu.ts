import { getSelectedModelsCommand } from "@virgultum/shared/commands";
import { editorMessage, TelemetryProvider } from "@virgultum/shared/services";
import { isInsideBlockByFlavour } from "@virgultum/shared/utils";
import type { SlashMenuConfig } from "@virgultum/widget-slash-menu";

import { insertTableBlockCommand } from "../commands";

export const tableSlashMenuConfig: SlashMenuConfig = {
  disableWhen: ({ model }) => model.flavour === "myoxus:table",
  items: [
    {
      id: "block-table-insert",
      label: editorMessage("com.myoxus.editor.slash.table", "Table"),
      description: editorMessage(
        "com.myoxus.editor.slash.table-description",
        "Create a simple table.",
      ),
      icon: "TableIcon",
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.table", "Table"),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 0,
      },
      when: ({ model }) =>
        !isInsideBlockByFlavour(model.store, model, "myoxus:edgeless-text"),
      action: ({ std }) => {
        std.command
          .chain()
          .pipe(getSelectedModelsCommand)
          .pipe(insertTableBlockCommand, {
            place: "after",
            removeEmptyLine: true,
          })
          .pipe(({ insertedTableBlockId }) => {
            if (insertedTableBlockId) {
              const telemetry = std.getOptional(TelemetryProvider);
              telemetry?.track("BlockCreated", {
                blockType: "myoxus:table",
              });
            }
          })
          .run();
      },
    },
  ],
};
