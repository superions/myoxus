import { ToolbarModuleExtension } from "@virgultum/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/std";

import { builtinInlineLinkToolbarConfig } from "./link-node/configs/toolbar.js";

export const linkToolbar = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:link"),
  config: builtinInlineLinkToolbarConfig,
});
