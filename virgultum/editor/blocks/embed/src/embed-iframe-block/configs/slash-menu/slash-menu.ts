import { getSelectedModelsCommand } from "@virgultum/shared/commands";
import { editorMessage } from "@virgultum/shared/services";
import type { SlashMenuConfig } from "@virgultum/widget-slash-menu";

import { insertEmptyEmbedIframeCommand } from "../../commands/insert-empty-embed-iframe";

export const embedIframeSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-embed-iframe",
      label: editorMessage("com.myoxus.editor.slash.embed", "Embed"),
      description: editorMessage(
        "com.myoxus.editor.slash.embed-description",
        "For Google Drive, and more.",
      ),
      icon: "EmbedIcon",
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.embed", "Embed"),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 5,
      },
      when: ({ model }) => {
        return model.store.schema.flavourSchemaMap.has("myoxus:embed-iframe");
      },
      action: ({ std }) => {
        std.command
          .chain()
          .pipe(getSelectedModelsCommand)
          .pipe(insertEmptyEmbedIframeCommand, {
            place: "after",
            removeEmptyLine: true,
            linkInputPopupOptions: {
              telemetrySegment: "slash menu",
            },
          })
          .run();
      },
    },
  ],
};
