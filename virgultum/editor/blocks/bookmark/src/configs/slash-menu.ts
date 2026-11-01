import { DefaultTool } from "@virgultum/block-surface";
import { toggleEmbedCardCreateModal } from "@virgultum/components/embed-card-modal";
import { BookmarkBlockSchema } from "@virgultum/model";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { editorMessage } from "@virgultum/shared/services";
import type { ExtensionType } from "@virgultum/store";
import {
  type SlashMenuConfig,
  SlashMenuConfigIdentifier,
} from "@virgultum/widget-slash-menu";

const bookmarkSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-bookmark-insert",
      label: editorMessage("Link", "Link"),
      description: editorMessage(
        "com.myoxus.editor.slash.bookmark-description",
        "Add a bookmark for reference.",
      ),
      icon: "LinkIcon",
      tooltip: {
        caption: editorMessage("Link", "Link"),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 2,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:bookmark"),
      action: ({ std, model }) => {
        const { host } = std;
        const parentModel = host.store.getParent(model);
        if (!parentModel) {
          return;
        }
        const index = parentModel.children.indexOf(model) + 1;
        toggleEmbedCardCreateModal(
          host,
          "Links",
          "The added link will be displayed as a card view.",
          { mode: "page", parentModel, index },
          ({ mode }) => {
            if (mode === "edgeless") {
              const gfx = std.get(GfxControllerIdentifier);
              gfx.tool.setTool(DefaultTool);
            }
          },
        )
          .then(() => {
            if (model.text?.length === 0) {
              model.store.deleteBlock(model);
            }
          })
          .catch(console.error);
      },
    },
  ],
};

export const BookmarkSlashMenuConfigIdentifier = SlashMenuConfigIdentifier(
  BookmarkBlockSchema.model.flavour,
);

export const BookmarkSlashMenuConfigExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(BookmarkSlashMenuConfigIdentifier, bookmarkSlashMenuConfig);
  },
};
