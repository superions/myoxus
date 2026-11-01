import { EmbedLinkedDocBlockSchema } from "@virgultum/model";
import { insertContent } from "@virgultum/rich-text";
import { REFERENCE_NODE } from "@virgultum/shared/consts";
import { editorMessage } from "@virgultum/shared/services";
import { createDefaultDoc } from "@virgultum/shared/utils";
import { type ExtensionType } from "@virgultum/store";
import {
  type SlashMenuConfig,
  SlashMenuConfigIdentifier,
} from "@virgultum/widget-slash-menu";

const linkedDocSlashMenuConfig: SlashMenuConfig = {
  items: [
    {
      id: "block-linked-doc-create",
      label: editorMessage("com.myoxus.editor.slash.linked-doc-new", "New Doc"),
      description: editorMessage(
        "com.myoxus.editor.slash.linked-doc-new-description",
        "Start a new document.",
      ),
      icon: "PlusIcon",
      tooltip: {
        caption: editorMessage(
          "com.myoxus.editor.slash.linked-doc-new",
          "New Doc",
        ),
      },
      group: {
        id: "page",
        label: editorMessage("Page", "Page"),
        order: 3,
        itemOrder: 0,
      },
      when: ({ model }) =>
        model.store.schema.flavourSchemaMap.has("myoxus:embed-linked-doc"),
      action: ({ std, model }) => {
        const newDoc = createDefaultDoc(std.host.store.workspace);
        insertContent(std, model, REFERENCE_NODE, {
          reference: {
            type: "LinkedPage",
            pageId: newDoc.id,
          },
        });
      },
    },
    {
      id: "block-linked-doc-existing",
      label: editorMessage(
        "com.myoxus.editor.slash.linked-doc-existing",
        "Link document",
      ),
      description: editorMessage(
        "com.myoxus.editor.slash.linked-doc-existing-description",
        "Link to another document.",
      ),
      icon: "LinkedPageIcon",
      tooltip: {
        caption: editorMessage(
          "com.myoxus.editor.slash.linked-doc-existing",
          "Link document",
        ),
      },
      searchAlias: [
        editorMessage(
          "com.myoxus.editor.slash.linked-doc-alias",
          "link document",
        ),
      ],
      group: {
        id: "page",
        label: editorMessage("Page", "Page"),
        order: 3,
        itemOrder: 1,
      },
      when: ({ std, model }) => {
        const root = model.store.root;
        if (!root) return false;
        const linkedDocWidget = std.view.getWidget(
          "myoxus-linked-doc-widget",
          root.id,
        );
        if (!linkedDocWidget) return false;

        return model.store.schema.flavourSchemaMap.has(
          "myoxus:embed-linked-doc",
        );
      },
      action: ({ model, std }) => {
        const root = model.store.root;
        if (!root) return;
        const linkedDocWidget = std.view.getWidget(
          "myoxus-linked-doc-widget",
          root.id,
        );
        if (!linkedDocWidget) return;
        // TODO(@L-Sun): make linked-doc-widget as extension
        // @ts-expect-error same as above
        linkedDocWidget.show({ addTriggerKey: true, primaryTriggerKey: "[[" });
      },
    },
  ],
};

export const LinkedDocSlashMenuConfigIdentifier = SlashMenuConfigIdentifier(
  EmbedLinkedDocBlockSchema.model.flavour,
);

export const LinkedDocSlashMenuConfigExtension: ExtensionType = {
  setup: (di) => {
    di.addImpl(LinkedDocSlashMenuConfigIdentifier, linkedDocSlashMenuConfig);
  },
};
