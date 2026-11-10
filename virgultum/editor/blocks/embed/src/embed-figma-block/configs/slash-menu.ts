import { DefaultTool } from "@virgultum/block-surface";
import { toggleEmbedCardCreateModal } from "@virgultum/components/embed-card-modal";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { editorMessage } from "@virgultum/shared/services";
import type { SlashMenuConfig } from "@virgultum/widget-slash-menu";

export const embedFigmaSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-embed-figma",
      label: editorMessage("com.myoxus.editor.slash.figma", "Figma"),
      description: editorMessage(
        "com.myoxus.editor.slash.figma-description",
        "Embed a Figma document.",
      ),
      icon: "FigmaDuotoneIcon",
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.figma", "Figma"),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 8,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:embed-figma"),
      action: ({ std, model }) => {
        (async () => {
          const { host } = std;
          const parentModel = host.store.getParent(model);
          if (!parentModel) {
            return;
          }
          const index = parentModel.children.indexOf(model) + 1;
          const inserted = await toggleEmbedCardCreateModal(
            host,
            "Figma",
            "The added Figma link will be displayed as an embed view.",
            { mode: "page", parentModel, index, sourceBlockId: model.id },
            ({ mode }) => {
              if (mode === "edgeless") {
                const gfx = std.get(GfxControllerIdentifier);
                gfx.tool.setTool(DefaultTool);
              }
            },
          );
          if (inserted && model.text?.length === 0)
            std.store.deleteBlock(model);
        })().catch(console.error);
      },
    },
  ],
};
