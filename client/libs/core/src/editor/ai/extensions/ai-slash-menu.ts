// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocModeProvider } from "@virgultum/editor/shared/services";
import {
  type SlashMenuActionItem,
  SlashMenuConfigExtension,
  type SlashMenuContext,
  type SlashMenuItem,
  type SlashMenuSubMenu,
} from "@virgultum/editor/widgets/slash-menu";

import { pageAIGroups } from "../_common/config";
import { handleInlineAskAIAction } from "../actions/doc-handler";
import type { AIItemConfig } from "../components/ai-item/types";
import { AIPanelControllerIdentifier } from "../widgets/ai-panel/controller";

const FROM_ABOVE_NAMES = new Set(["Fix spelling", "Fix grammar"]);
const DIRECT_SLASH_NAMES = new Set(["Summarize", "Continue writing"]);
const SUBMENU_GROUP_NAMES = new Set(["Translate to", "Change tone to"]);
const SUBMENU_ACTION_NAMES = new Set([
  "Improve writing",
  "Make it longer",
  "Make it shorter",
  "Generate outline",
  "Find actions",
]);

function makeWhenGuard(item?: AIItemConfig) {
  return ({ std }: SlashMenuContext) => {
    if (!std.getOptional(AIPanelControllerIdentifier)) return false;
    const mode = std.get(DocModeProvider).getPrimaryMode(std.host.store.id);
    return item?.showWhen?.(std.host.command.chain(), mode, std.host) ?? true;
  };
}

function toActionItem(item: AIItemConfig): SlashMenuActionItem {
  return {
    name: item.name,
    icon: item.iconName,
    searchAlias: ["ai"],
    when: makeWhenGuard(item),
    action: ({ std }) => item.handler?.(std.host),
  };
}

function toSubMenuItem(item: AIItemConfig): SlashMenuSubMenu {
  return {
    name: item.name,
    icon: item.iconName,
    searchAlias: ["ai"],
    when: makeWhenGuard(item),
    subMenu: (item.subItem ?? []).map<SlashMenuActionItem>(
      ({ type, handler }) => ({
        name: type,
        action: ({ std }) => handler?.(std.host),
      }),
    ),
  };
}

export function AiSlashMenuConfigExtension() {
  const allItems = pageAIGroups.flatMap((group) => group.items);
  let order = 0;

  const items: SlashMenuItem[] = [
    {
      name: "Ask AI",
      icon: "AiIcon",
      when: makeWhenGuard(),
      action: ({ std }) => {
        const panel = std.getOptional(AIPanelControllerIdentifier);
        if (panel) {
          handleInlineAskAIAction(panel.host);
        }
      },
    },
    ...allItems
      .filter((item) => FROM_ABOVE_NAMES.has(item.name))
      .map<SlashMenuActionItem>((item) => ({
        ...toActionItem(item),
        name: `${item.name} from above`,
        group: `1_Myoxus AI@${order++}`,
      })),
    ...allItems
      .filter((item) => DIRECT_SLASH_NAMES.has(item.name))
      .map<SlashMenuActionItem>((item) => ({
        ...toActionItem(item),
        group: `1_Myoxus AI@${order++}`,
      })),
    {
      name: "Action with above",
      icon: "MoreHorizontalIcon",
      group: `1_Myoxus AI@${order++}`,
      subMenu: [
        ...allItems
          .filter((item) => SUBMENU_GROUP_NAMES.has(item.name))
          .map(toSubMenuItem),
        ...allItems
          .filter((item) => SUBMENU_ACTION_NAMES.has(item.name))
          .map(toActionItem),
      ],
    },
  ];

  return SlashMenuConfigExtension("ai", { items });
}
