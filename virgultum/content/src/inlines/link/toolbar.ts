import { ToolbarModuleExtension } from "@virgultum/core/services";
import { BlockFlavourIdentifier } from "@virgultum/core/runtime";

import { builtinInlineLinkToolbarConfig } from "./link-node/configs/toolbar";

export const linkToolbar = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:link"),
  config: builtinInlineLinkToolbarConfig,
});
