import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { toggleEmbedCardCreateModal } from "../../../card-session";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { editorMessage } from "@virgultum/core/services";
import type { SlashMenuConfig } from "@virgultum/core/slash-menu";

export const embedLoomSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-embed-loom",
      label: editorMessage("com.myoxus.editor.slash.loom", "Loom"),
      icon: "LoomLogoDuotoneIcon",
      description: editorMessage(
        "com.myoxus.editor.slash.loom-description",
        "Embed a Loom video.",
      ),
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.loom", "Loom"),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 9,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:embed-loom"),
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
            "Loom",
            "The added Loom video link will be displayed as an embed view.",
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
