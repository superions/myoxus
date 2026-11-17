import { calloutPresentation } from "@virgultum/core/models";
import { IconType } from "@virgultum/core/services";
import { calloutPresets } from "../presets";
import { focusBlockEnd } from "@virgultum/core/commands";
import { editorMessage } from "@virgultum/core/services";
import { isInsideBlockByFlavour } from "@virgultum/core/utils";
import {
  type SlashMenuConfig,
  type SlashMenuActionItem,
} from "@virgultum/core/slash-menu";

const presetItems = calloutPresets.map<SlashMenuActionItem>(
  ({ type, label }, itemOrder) => ({
    id:
      type === "note" ? "block-callout-insert" : `block-callout-${type}-insert`,
    label:
      type === "note"
        ? editorMessage("com.myoxus.editor.slash.callout", "Callout")
        : label,
    description: editorMessage(
      "com.myoxus.editor.slash.callout-description",
      "Let your words stand out.",
    ),
    icon: "MegaphoneIcon",
    tooltip: {
      caption: editorMessage("com.myoxus.editor.slash.callout", "Callout"),
    },
    searchAlias: [
      // Keep the canonical command independent of translated display labels.
      `callout-${type}`,
      `callout ${type}`,
      type,
      ...(type === "note" ? ["callout"] : []),
      label,
      ...(type === "note"
        ? [editorMessage("com.myoxus.editor.slash.callout-alias", "callout")]
        : []),
    ],
    group: {
      id: "callouts",
      label: editorMessage("com.myoxus.editor.group.callouts", "Callouts"),
      order: 3,
      itemOrder,
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
        {
          type,
          icon: {
            type: IconType.Emoji,
            unicode: calloutPresentation(type).icon,
          },
          backgroundColorName: calloutPresentation(type).background,
        },
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
  }),
);

const commonIds = new Set([
  "block-callout-insert",
  "block-callout-info-insert",
  "block-callout-tip-insert",
  "block-callout-warning-insert",
]);

export const calloutSlashMenuConfig: SlashMenuConfig = {
  items: [
    ...presetItems.filter((item) => commonIds.has(item.id!)),
    {
      id: "block-callout-more",
      label: editorMessage("com.myoxus.editor.callout.more", "More"),
      icon: "MegaphoneIcon",
      group: {
        id: "callouts",
        label: editorMessage("com.myoxus.editor.group.callouts", "Callouts"),
        order: 3,
        itemOrder: calloutPresets.length,
      },
      when: presetItems[0].when,
      subMenu: presetItems.filter((item) => !commonIds.has(item.id!)),
    },
  ],
};
