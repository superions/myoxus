import { focusBlockEnd } from "@virgultum/shared/commands";
import { editorMessage } from "@virgultum/shared/services";
import { isInsideBlockByFlavour } from "@virgultum/shared/utils";
import { type SlashMenuConfig } from "@virgultum/widget-slash-menu";

export const calloutSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-callout-insert",
      label: editorMessage("com.myoxus.editor.slash.callout", "Callout"),
      description: editorMessage(
        "com.myoxus.editor.slash.callout-description",
        "Let your words stand out.",
      ),
      icon: "FontIcon",
      tooltip: {
        caption: editorMessage("com.myoxus.editor.slash.callout", "Callout"),
      },
      searchAlias: [
        editorMessage("com.myoxus.editor.slash.callout-alias", "callout"),
      ],
      group: {
        id: "basic",
        label: editorMessage("com.myoxus.editor.group.basic", "Basic"),
        order: 0,
        itemOrder: 9,
      },
      when: ({ model }) => {
        return !isInsideBlockByFlavour(
          model.store,
          model,
          "myoxus:edgeless-text",
        );
      },
      action: ({ model, std }) => {
        const { store } = model;
        const parent = store.getParent(model);
        if (!parent) return;

        const index = parent.children.indexOf(model);
        if (index === -1) return;
        const calloutId = store.addBlock(
          "myoxus:callout",
          {},
          parent,
          index + 1,
        );
        if (!calloutId) return;
        const paragraphId = store.addBlock("myoxus:paragraph", {}, calloutId);
        if (!paragraphId) return;
        std.host.updateComplete
          .then(() => {
            const paragraph = std.view.getBlock(paragraphId);
            if (!paragraph) return;
            std.command.exec(focusBlockEnd, {
              focusBlock: paragraph,
            });
          })
          .catch(console.error);
      },
    },
  ],
};
