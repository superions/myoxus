import { ToolbarModuleExtension } from "@virgultum/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";

import { builtinLockedToolbarConfig, builtinMiscToolbarConfig } from "./misc";

export const EdgelessElementToolbarExtension: ExtensionType[] = [
  ToolbarModuleExtension({
    id: BlockFlavourIdentifier("myoxus:surface:*"),
    config: builtinMiscToolbarConfig,
  }),

  // Special Scenarios
  // Only display the `unlock` button when the selection includes a locked element.
  ToolbarModuleExtension({
    id: BlockFlavourIdentifier("myoxus:surface:locked"),
    config: builtinLockedToolbarConfig,
  }),
];
