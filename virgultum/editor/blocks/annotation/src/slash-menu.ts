// SPDX-License-Identifier: AGPL-3.0-or-later
import { editorMessage } from "@virgultum/shared/services";
import type { SlashMenuConfig } from "@virgultum/widget-slash-menu";

export const annotationSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-annotation-insert",
      label: editorMessage("com.myoxus.editor.annotation", "Annotation"),
      icon: "FileTextIcon",
      searchAlias: ["annotate"],
      group: {
        id: "basic",
        label: editorMessage("com.myoxus.editor.group.basic", "Basic"),
        order: 0,
        itemOrder: 10,
      },
      when: ({ model }) =>
        !model.store.readonly &&
        model.store.schema.flavourSchemaMap.has("myoxus:annotation"),
      action: ({ std, model }) => {
        const parent = model.store.getParent(model);
        if (!parent || model.store.readonly) return;
        const index = parent.children.indexOf(model);
        if (index < 0) return;
        model.store.captureSync();
        const id = model.store.addBlock(
          "myoxus:annotation",
          {},
          parent,
          index + 1,
        );
        // The slash owner already removed its query. Replace an empty leaf
        // rather than leaving a blank authoring row above the new block.
        if (model.text?.length === 0 && model.children.length === 0) {
          model.store.deleteBlock(model);
        }
        model.store.captureSync();
        void std.host.updateComplete.then(() => {
          const block = std.view.getBlock(id);
          if (block?.flavour === "myoxus:annotation") {
            (
              block as HTMLElementTagNameMap["myoxus-annotation"]
            ).startEditing();
          }
        });
      },
    },
  ],
};
