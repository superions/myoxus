import { ConfigExtensionFactory } from "@virgultum/core/runtime";

import type { BlockStdScope } from "../runtime/index";
import type { SelectionAction } from "./toolbar-service/presentation";
import type { MenuContext } from "./menu-context";

/** Existing extra-action configuration; toolbar rendering remains at its UI owner. */
export interface ToolbarMoreMenuConfig {
  actions: (context: MenuContext) => SelectionAction[];
}

export const ToolbarMoreMenuConfigExtension = ConfigExtensionFactory<
  Partial<ToolbarMoreMenuConfig>
>("myoxus-toolbar-more-menu");

export function getMoreMenuConfig(std: BlockStdScope): ToolbarMoreMenuConfig {
  return {
    actions: () => [],
    ...std.getOptional(ToolbarMoreMenuConfigExtension.identifier),
  };
}
