import { slashMenuToolTips } from "./help";
import type { ListBlockModel, ParagraphBlockModel } from "@virgultum/model";
import { insertContent } from "@virgultum/rich-text";
import {
  editorMessage,
  MyoxusHostServiceIdentifier,
} from "@virgultum/shared/services";
import { editorToast } from "@virgultum/shared/utils";
import { type DeltaInsert, Slice, Text } from "@virgultum/store";

import type { SlashMenuConfig } from "./types";
import { formatDate, formatTime } from "./utils";

const dateGroup = (itemOrder: number) => ({
  id: "date",
  label: editorMessage("Date", "Date"),
  order: 6,
  itemOrder,
});

const actionGroup = (itemOrder: number) => ({
  id: "actions",
  label: editorMessage("com.myoxus.actions", "Actions"),
  order: 8,
  itemOrder,
});

export const defaultSlashMenuConfig: SlashMenuConfig = {
  items: () => {
    const now = new Date();
    const tomorrow = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return [
      {
        id: "action-insert-building-block",
        label: editorMessage(
          "com.myoxus.templates.blocks.insert",
          "Insert building block…",
        ),
        icon: "TemplateIcon",
        group: actionGroup(5),
        when: ({ std }) =>
          !std.store.readonly &&
          Boolean(
            std.getOptional(MyoxusHostServiceIdentifier)
              ?.openBuildingBlockPicker,
          ),
        action: ({ std }) =>
          std
            .getOptional(MyoxusHostServiceIdentifier)
            ?.openBuildingBlockPicker?.(std),
      },
      {
        id: "action-today",
        label: editorMessage("com.myoxus.common.calendar.today", "Today"),
        icon: "TodayIcon",
        tooltip: slashMenuToolTips["action-today"],
        description: formatDate(now),
        group: dateGroup(0),
        action: ({ std, model }) => {
          insertContent(std, model, formatDate(now));
        },
      },
      {
        id: "action-tomorrow",
        label: editorMessage("com.myoxus.tomorrow", "Tomorrow"),
        icon: "TomorrowIcon",
        tooltip: slashMenuToolTips["action-tomorrow"],
        description: formatDate(tomorrow),
        group: dateGroup(1),
        action: ({ std, model }) => {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          insertContent(std, model, formatDate(tomorrow));
        },
      },
      {
        id: "action-yesterday",
        label: editorMessage("com.myoxus.yesterday", "Yesterday"),
        icon: "YesterdayIcon",
        tooltip: slashMenuToolTips["action-yesterday"],
        description: formatDate(yesterday),
        group: dateGroup(2),
        action: ({ std, model }) => {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          insertContent(std, model, formatDate(yesterday));
        },
      },
      {
        id: "action-now",
        label: editorMessage("com.myoxus.time.now", "Now"),
        icon: "NowIcon",
        tooltip: slashMenuToolTips["action-now"],
        description: formatTime(now),
        group: dateGroup(3),
        action: ({ std, model }) => {
          insertContent(std, model, formatTime(now));
        },
      },
      {
        id: "action-move-up",
        label: editorMessage("com.myoxus.editor.slash.move-up", "Move Up"),
        description: editorMessage(
          "com.myoxus.editor.slash.move-up-description",
          "Shift this line up.",
        ),
        icon: "ArrowUpBigIcon",
        tooltip: slashMenuToolTips["action-move-up"],
        group: actionGroup(0),
        action: ({ std, model }) => {
          const { host } = std;
          const previousSiblingModel = host.store.getPrev(model);
          if (!previousSiblingModel) return;

          const parentModel = host.store.getParent(previousSiblingModel);
          if (!parentModel) return;

          host.store.moveBlocks(
            [model],
            parentModel,
            previousSiblingModel,
            true,
          );
        },
      },
      {
        id: "action-move-down",
        label: editorMessage("com.myoxus.editor.slash.move-down", "Move Down"),
        description: editorMessage(
          "com.myoxus.editor.slash.move-down-description",
          "Shift this line down.",
        ),
        icon: "ArrowDownBigIcon",
        tooltip: slashMenuToolTips["action-move-down"],
        group: actionGroup(1),
        action: ({ std, model }) => {
          const { host } = std;
          const nextSiblingModel = host.store.getNext(model);
          if (!nextSiblingModel) return;

          const parentModel = host.store.getParent(nextSiblingModel);
          if (!parentModel) return;

          host.store.moveBlocks([model], parentModel, nextSiblingModel, false);
        },
      },
      {
        id: "action-copy",
        label: editorMessage("Copy", "Copy"),
        description: editorMessage(
          "com.myoxus.editor.slash.copy-description",
          "Copy this line to clipboard.",
        ),
        icon: "CopyIcon",
        tooltip: slashMenuToolTips["action-copy"],
        group: actionGroup(2),
        action: ({ std, model }) => {
          const slice = Slice.fromModels(std.store, [model]);

          std.clipboard
            .copy(slice)
            .then(() => {
              editorToast(
                std.host,
                editorMessage("Copied to clipboard", "Copied to clipboard"),
              );
            })
            .catch((e) => {
              console.error(e);
            });
        },
      },
      {
        id: "action-duplicate",
        label: editorMessage("com.myoxus.header.option.duplicate", "Duplicate"),
        description: editorMessage(
          "com.myoxus.editor.slash.duplicate-description",
          "Create a duplicate of this line.",
        ),
        icon: "DualLinkIcon",
        tooltip: slashMenuToolTips["action-copy"],
        group: actionGroup(3),
        action: ({ std, model }) => {
          if (!model.text || !(model.text instanceof Text)) {
            console.error("Can't duplicate a block without text");
            return;
          }
          const { host } = std;
          const parent = host.store.getParent(model);
          if (!parent) {
            console.error(
              "Failed to duplicate block! Parent not found: " +
                model.id +
                "|" +
                model.flavour,
            );
            return;
          }
          const index = parent.children.indexOf(model);

          // FIXME: this clone is not correct
          host.store.addBlock(
            model.flavour,
            {
              type: (model as ParagraphBlockModel).props.type,
              text: new Text(
                (
                  model as ParagraphBlockModel
                ).props.text.toDelta() as DeltaInsert[],
              ),
              checked: (model as ListBlockModel).props.checked,
            },
            host.store.getParent(model),
            index,
          );
        },
      },
      {
        id: "action-delete",
        label: editorMessage("Delete", "Delete"),
        description: editorMessage(
          "com.myoxus.editor.slash.delete-description",
          "Remove this line permanently.",
        ),
        searchAlias: [
          editorMessage("com.myoxus.editor.slash.remove-alias", "remove"),
        ],
        icon: "DeleteIcon",
        tooltip: slashMenuToolTips["action-delete"],
        group: actionGroup(4),
        action: ({ std, model }) => {
          std.host.store.deleteBlock(model);
        },
      },
    ];
  },
};
