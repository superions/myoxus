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
import {
  MYOXUS_AI_PANEL_WIDGET,
  type MyoxusAIPanelWidget,
} from "../widgets/ai-panel/ai-panel";

export function AiSlashMenuConfigExtension() {
  const AIItems = pageAIGroups.flatMap((group) => group.items);
  const showWhenWrapper =
    (item?: AIItemConfig) =>
    ({ std }: SlashMenuContext) => {
      const root = std.host.store.root;
      if (!root) return false;
      const myoxusAIPanelWidget = std.view.getWidget(
        MYOXUS_AI_PANEL_WIDGET,
        root.id,
      );
      if (myoxusAIPanelWidget === null) return false;

      const chain = std.host.command.chain();
      const docModeService = std.get(DocModeProvider);
      const editorMode = docModeService.getPrimaryMode(std.host.store.id);

      return item?.showWhen?.(chain, editorMode, std.host) ?? true;
    };

  const actionItemWrapper = (item: AIItemConfig): SlashMenuActionItem => ({
    ...basicItemConfig(item),
    action: ({ std }: SlashMenuContext) => {
      item?.handler?.(std.host);
    },
  });

  const subMenuWrapper = (item: AIItemConfig): SlashMenuSubMenu => {
    return {
      ...basicItemConfig(item),
      subMenu: (item.subItem ?? []).map<SlashMenuActionItem>(
        ({ type, handler }) => ({
          name: type,
          action: ({ std }) => handler?.(std.host),
        }),
      ),
    };
  };

  const basicItemConfig = (item: AIItemConfig) => {
    return {
      name: item.name,
      icon: item.iconName,
      searchAlias: ["ai"],
      when: showWhenWrapper(item),
    };
  };

  let index = 0;
  const AIMenuItems: SlashMenuItem[] = [
    {
      name: "Ask AI",
      icon: "AiIcon",
      when: showWhenWrapper(),
      action: ({ std }) => {
        const root = std.host.store.root;
        if (!root) return;
        const myoxusAIPanelWidget = std.view.getWidget(
          MYOXUS_AI_PANEL_WIDGET,
          root.id,
        ) as MyoxusAIPanelWidget;
        handleInlineAskAIAction(myoxusAIPanelWidget.host);
      },
    },
    ...AIItems.filter(({ name }) =>
      ["Fix spelling", "Fix grammar"].includes(name),
    ).map<SlashMenuActionItem>((item) => ({
      ...actionItemWrapper(item),
      name: `${item.name} from above`,
      group: `1_Myoxus AI@${index++}`,
    })),

    ...AIItems.filter(({ name }) =>
      ["Summarize", "Continue writing"].includes(name),
    ).map<SlashMenuActionItem>((item) => ({
      ...actionItemWrapper(item),
      group: `1_Myoxus AI@${index++}`,
    })),

    {
      name: "Action with above",
      icon: "MoreHorizontalIcon",
      group: `1_Myoxus AI@${index++}`,
      subMenu: [
        ...AIItems.filter(({ name }) =>
          ["Translate to", "Change tone to"].includes(name),
        ).map(subMenuWrapper),

        ...AIItems.filter(({ name }) =>
          [
            "Improve writing",
            "Make it longer",
            "Make it shorter",
            "Generate outline",
            "Find actions",
          ].includes(name),
        ).map(actionItemWrapper),
      ],
    },
  ];

  return SlashMenuConfigExtension("ai", {
    items: AIMenuItems,
  });
}
