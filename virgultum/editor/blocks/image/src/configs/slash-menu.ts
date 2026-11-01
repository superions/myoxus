import { getSelectedModelsCommand } from "@virgultum/shared/commands";
import { editorMessage } from "@virgultum/shared/services";
import { type SlashMenuConfig } from "@virgultum/widget-slash-menu";

import { insertImagesCommand } from "../commands";

export const imageSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-image-insert",
      label: editorMessage("Image", "Image"),
      description: editorMessage(
        "com.myoxus.editor.slash.image-description",
        "Insert an image.",
      ),
      icon: "ImageIcon",
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.photo", "Photo"),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 1,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:image"),
      action: ({ std }) => {
        const [success, ctx] = std.command
          .chain()
          .pipe(getSelectedModelsCommand)
          .pipe(insertImagesCommand, { removeEmptyLine: true })
          .run();

        if (success) ctx.insertedImageIds.catch(console.error);
      },
    },
  ],
};
