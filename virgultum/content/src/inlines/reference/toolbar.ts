import { ToolbarModuleExtension } from "@virgultum/core/services";
import { BlockFlavourIdentifier } from "@virgultum/core/runtime";

import { builtinInlineReferenceToolbarConfig } from "./reference-node/configs/toolbar";

export const referenceNodeToolbar = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:reference"),
  config: builtinInlineReferenceToolbarConfig,
});
