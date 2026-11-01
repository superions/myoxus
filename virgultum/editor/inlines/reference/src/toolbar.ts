import { ToolbarModuleExtension } from "@virgultum/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/std";

import { builtinInlineReferenceToolbarConfig } from "./reference-node/configs/toolbar";

export const referenceNodeToolbar = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:reference"),
  config: builtinInlineReferenceToolbarConfig,
});
