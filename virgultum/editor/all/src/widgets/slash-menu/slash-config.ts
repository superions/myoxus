// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  insertContent,
  openTemplateFieldPicker,
} from "@virgultum/content/rich-text";
import type {
  ListBlockModel,
  ParagraphBlockModel,
} from "@virgultum/core/models";
import {
  editorMessage,
  MyoxusHostServiceIdentifier,
} from "@virgultum/core/services";
import type {
  SlashMenuConfig,
  SlashMenuItem,
} from "@virgultum/core/slash-menu";
import { type DeltaInsert, Slice, Text } from "@virgultum/core/store";
import { editorToast } from "@virgultum/core/utils";

export const MYOXUS_SLASH_MENU_WIDGET = "myoxus-slash-menu-widget";
export const SLASH_TRIGGER_KEYS = ["/", "、"] as const;

export function matchSlashTriggerSuffix(text: string): string | undefined {
  return SLASH_TRIGGER_KEYS.find((key) => text.endsWith(key));
}

export function hasSlashTriggerChar(text: string): boolean {
  return SLASH_TRIGGER_KEYS.some((key) => text.includes(key));
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

function formatIsoDate(date: Date): string {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`;
}

function formatIsoDateTime(date: Date): string {
  return `${formatIsoDate(date)} ${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

function shiftDays(base: Date, offsetDays: number): Date {
  const shifted = new Date(base.getTime());
  shifted.setDate(shifted.getDate() + offsetDays);
  return shifted;
}

function dateGroup(itemOrder: number): NonNullable<SlashMenuItem["group"]> {
  return {
    id: "date",
    label: editorMessage("Date", "Date"),
    order: 6,
    itemOrder,
  };
}

function actionGroup(itemOrder: number): NonNullable<SlashMenuItem["group"]> {
  return {
    id: "actions",
    label: editorMessage("com.myoxus.actions", "Actions"),
    order: 8,
    itemOrder,
  };
}

export const defaultSlashMenuConfig: SlashMenuConfig = {
  items: (): SlashMenuItem[] => {
    const now = new Date();
    const tomorrow = shiftDays(now, 1);
    const yesterday = shiftDays(now, -1);

    const todayLabel = editorMessage(
      "com.myoxus.common.calendar.today",
      "Today",
    );
    const tomorrowLabel = editorMessage("com.myoxus.tomorrow", "Tomorrow");
    const yesterdayLabel = editorMessage("com.myoxus.yesterday", "Yesterday");
    const nowLabel = editorMessage("com.myoxus.time.now", "Now");
    const moveUpLabel = editorMessage(
      "com.myoxus.editor.slash.move-up",
      "Move Up",
    );
    const moveDownLabel = editorMessage(
      "com.myoxus.editor.slash.move-down",
      "Move Down",
    );
    const copyLabel = editorMessage("Copy", "Copy");
    const deleteLabel = editorMessage("Delete", "Delete");

    return [
      {
        id: "action-insert-document-field",
        label: editorMessage(
          "com.myoxus.editor.field.document-fields",
          "Document fields",
        ),
        icon: "TextTypeIcon",
        group: actionGroup(4),
        when: ({ std, model }) =>
          !std.store.readonly &&
          (model.flavour === "myoxus:paragraph" ||
            model.flavour === "myoxus:list") &&
          Boolean(
            std.getOptional(MyoxusHostServiceIdentifier)
              ?.openTemplateVariablePicker,
          ),
        action: ({ std, model }) => openTemplateFieldPicker(std, model),
      },
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
        label: todayLabel,
        icon: "TodayIcon",
        tooltip: { caption: todayLabel },
        description: formatIsoDate(now),
        group: dateGroup(0),
        action: ({ std, model }) => {
          insertContent(std, model, formatIsoDate(now));
        },
      },
      {
        id: "action-tomorrow",
        label: tomorrowLabel,
        icon: "TomorrowIcon",
        tooltip: { caption: tomorrowLabel },
        description: formatIsoDate(tomorrow),
        group: dateGroup(1),
        action: ({ std, model }) => {
          insertContent(std, model, formatIsoDate(shiftDays(new Date(), 1)));
        },
      },
      {
        id: "action-yesterday",
        label: yesterdayLabel,
        icon: "YesterdayIcon",
        tooltip: { caption: yesterdayLabel },
        description: formatIsoDate(yesterday),
        group: dateGroup(2),
        action: ({ std, model }) => {
          insertContent(std, model, formatIsoDate(shiftDays(new Date(), -1)));
        },
      },
      {
        id: "action-now",
        label: nowLabel,
        icon: "NowIcon",
        tooltip: { caption: nowLabel },
        description: formatIsoDateTime(now),
        group: dateGroup(3),
        action: ({ std, model }) => {
          insertContent(std, model, formatIsoDateTime(now));
        },
      },
      {
        id: "action-move-up",
        label: moveUpLabel,
        description: editorMessage(
          "com.myoxus.editor.slash.move-up-description",
          "Shift this line up.",
        ),
        icon: "ArrowUpBigIcon",
        tooltip: { caption: moveUpLabel },
        group: actionGroup(0),
        action: ({ std, model }) => {
          const prev = std.host.store.getPrev(model);
          if (!prev) return;
          const parent = std.host.store.getParent(prev);
          if (!parent) return;
          std.host.store.moveBlocks([model], parent, prev, true);
        },
      },
      {
        id: "action-move-down",
        label: moveDownLabel,
        description: editorMessage(
          "com.myoxus.editor.slash.move-down-description",
          "Shift this line down.",
        ),
        icon: "ArrowDownBigIcon",
        tooltip: { caption: moveDownLabel },
        group: actionGroup(1),
        action: ({ std, model }) => {
          const next = std.host.store.getNext(model);
          if (!next) return;
          const parent = std.host.store.getParent(next);
          if (!parent) return;
          std.host.store.moveBlocks([model], parent, next, false);
        },
      },
      {
        id: "action-copy",
        label: copyLabel,
        description: editorMessage(
          "com.myoxus.editor.slash.copy-description",
          "Copy this line to clipboard.",
        ),
        icon: "CopyIcon",
        tooltip: { caption: copyLabel },
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
            .catch((error) => {
              console.error(error);
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
        tooltip: { caption: copyLabel },
        group: actionGroup(3),
        action: ({ std, model }) => {
          if (!model.text || !(model.text instanceof Text)) return;
          const parent = std.host.store.getParent(model);
          if (!parent) return;
          const insertIndex = parent.children.indexOf(model);
          std.host.store.addBlock(
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
            parent,
            insertIndex,
          );
        },
      },
      {
        id: "action-delete",
        label: deleteLabel,
        description: editorMessage(
          "com.myoxus.editor.slash.delete-description",
          "Remove this line permanently.",
        ),
        searchAlias: [
          editorMessage("com.myoxus.editor.slash.remove-alias", "remove"),
        ],
        icon: "DeleteIcon",
        tooltip: { caption: deleteLabel },
        group: actionGroup(4),
        action: ({ std, model }) => {
          std.host.store.deleteBlock(model);
        },
      },
    ];
  },
};
