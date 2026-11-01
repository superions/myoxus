// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  ToolbarActions,
  ToolbarContext,
} from "@virgultum/editor/shared/services";
import type { AIItemGroupConfig } from "../components/ai-item/types";
import { getAIPanelWidget } from "../utils/ai-widgets";

/** Present the existing AI catalogue; handlers remain the only command authority. */
export function aiToolbarActions(
  context: ToolbarContext,
  groups: AIItemGroupConfig[],
  restoreSelection = false,
): ToolbarActions {
  const run = (handler?: AIItemGroupConfig["items"][number]["handler"]) => {
    if (restoreSelection) getAIPanelWidget(context.host).restoreSelection();
    handler?.(context.host);
  };
  return groups.map((group, index) => ({
    id: group.testId ?? `ai-group-${index}`,
    actions: group.items
      .filter(
        (item) =>
          item.showWhen?.(context.chain, context.editorMode, context.host) ??
          true,
      )
      .map((item) => ({
        id: item.testId,
        label: item.name,
        icon: item.iconName,
        ...(item.subItem?.length
          ? {
              control: {
                type: "menu" as const,
                items: item.subItem.map((sub) => ({
                  id: sub.testId ?? sub.type,
                  label: sub.type,
                  run: () => run(sub.handler),
                })),
              },
            }
          : { run: () => run(item.handler) }),
      })),
  }));
}
