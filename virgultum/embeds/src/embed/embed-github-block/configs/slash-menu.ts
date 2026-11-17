import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { toggleEmbedCardCreateModal } from "../../../card-session";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { editorMessage } from "@virgultum/core/services";
import type { SlashMenuConfig } from "@virgultum/core/slash-menu";

export const embedGithubSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-embed-github",
      label: editorMessage(
        "com.myoxus.editor.slash.github",
        "Git Issues & Pull Requests",
      ),
      description: editorMessage(
        "com.myoxus.editor.slash.github-description",
        "Link to a GitHub, GitLab or Forgejo/Gitea issue or pull/merge request.",
      ),
      icon: "CodeIcon",
      tooltip: {
        caption: editorMessage(
          "com.myoxus.editor.slash.github-repo",
          "Git Issue / Pull Request",
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
          const inserted = await toggleEmbedCardCreateModal(
            host,
            "Git Issues & Pull Requests",
            "The added GitHub, GitLab or Forgejo/Gitea issue or pull/merge request link will be displayed as a card view.",
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
