import { DefaultTool } from "@virgultum/block-surface";
import { toggleEmbedCardCreateModal } from "@virgultum/components/embed-card-modal";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { editorMessage } from "@virgultum/shared/services";
import type { SlashMenuConfig } from "@virgultum/widget-slash-menu";

export const embedGithubSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-embed-github",
      label: editorMessage("com.myoxus.editor.slash.github", "GitHub"),
      description: editorMessage(
        "com.myoxus.editor.slash.github-description",
        "Link to a GitHub repository.",
      ),
      icon: "GithubDuotoneIcon",
      tooltip: {
        caption: editorMessage(
          "com.myoxus.editor.slash.github-repo",
          "GitHub Repo",
        ),
      },
      group: {
        id: "content-media",
        label: editorMessage(
          "com.myoxus.editor.group.content-media",
          "Content & Media",
        ),
        order: 4,
        itemOrder: 7,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:embed-github"),
      action: ({ std, model }) => {
        (async () => {
          const { host } = std;
          const parentModel = host.store.getParent(model);
          if (!parentModel) {
            return;
          }
          const index = parentModel.children.indexOf(model) + 1;
          await toggleEmbedCardCreateModal(
            host,
            "GitHub",
            "The added GitHub issue or pull request link will be displayed as a card view.",
            { mode: "page", parentModel, index },
            ({ mode }) => {
              if (mode === "edgeless") {
                const gfx = std.get(GfxControllerIdentifier);
                gfx.tool.setTool(DefaultTool);
              }
            },
          );
          if (model.text?.length === 0) std.store.deleteBlock(model);
        })().catch(console.error);
      },
    },
  ],
};
