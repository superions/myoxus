import { editorMessage } from "@virgultum/shared/services";
import { openSingleFileWith } from "@virgultum/shared/utils";
import { type SlashMenuConfig } from "@virgultum/widget-slash-menu";

import { addSiblingAttachmentBlocks } from "../utils";

export const attachmentSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-attachment-insert",
      label: editorMessage("com.myoxus.editor.slash.attachment", "Attachment"),
      description: editorMessage(
        "com.myoxus.editor.slash.attachment-description",
        "Attach a file to document.",
      ),
      icon: "FileIcon",
      tooltip: {
        caption: editorMessage(
          "com.myoxus.editor.slash.attachment",
          "Attachment",
        ),
      },
      searchAlias: [
        editorMessage("com.myoxus.editor.slash.attachment", "Attachment"),
      ],
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 3,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:attachment"),
      action: ({ std, model }) => {
        (async () => {
          const file = await openSingleFileWith();
          if (!file) return;

          await addSiblingAttachmentBlocks(std, [file], model);
          if (model.text?.length === 0) {
            std.store.deleteBlock(model);
          }
        })().catch(console.error);
      },
    },
    {
      id: "block-attachment-pdf",
      label: editorMessage("com.myoxus.editor.slash.pdf", "PDF"),
      description: editorMessage(
        "com.myoxus.editor.slash.pdf-description",
        "Upload a PDF to document.",
      ),
      icon: "ExportToPdfIcon",
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.pdf", "PDF"),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 4,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:attachment"),
      action: ({ std, model }) => {
        (async () => {
          const file = await openSingleFileWith();
          if (!file) return;

          await addSiblingAttachmentBlocks(std, [file], model);
          if (model.text?.length === 0) {
            std.store.deleteBlock(model);
          }
        })().catch(console.error);
      },
    },
  ],
};
