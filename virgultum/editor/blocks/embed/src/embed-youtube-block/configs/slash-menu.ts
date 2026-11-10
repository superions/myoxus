import { DefaultTool } from "@virgultum/block-surface";
import { toggleEmbedCardCreateModal } from "@virgultum/components/embed-card-modal";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { editorMessage } from "@virgultum/shared/services";
import type { SlashMenuConfig } from "@virgultum/widget-slash-menu";

export const embedYoutubeSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-embed-youtube",
      label: editorMessage("com.myoxus.editor.slash.youtube", "YouTube"),
      description: editorMessage(
        "com.myoxus.editor.slash.youtube-description",
        "Embed a YouTube video.",
      ),
      icon: "YoutubeDuotoneIcon",
      tooltip: {
        caption: editorMessage(
          "com.myoxus.editor.slash.youtube-video",
          "YouTube Video",
        ),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 6,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:embed-youtube"),
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
            "YouTube",
            "The added YouTube video link will be displayed as an embed view.",
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
