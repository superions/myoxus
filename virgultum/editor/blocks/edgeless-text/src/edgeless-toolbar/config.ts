import { createTextActions } from "@virgultum/gfx-text";
import { EdgelessTextBlockModel } from "@virgultum/model";
import {
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from "@virgultum/shared/services";
import { BlockFlavourIdentifier } from "@virgultum/std";

export const edgelessTextToolbarConfig = {
  // No need to adjust element bounds, which updates itself using ResizeObserver
  actions: createTextActions(
    EdgelessTextBlockModel,
    "edgeless-text",
    undefined,
    (model) => model.props,
  ),

  when: (ctx) => ctx.getSurfaceModelsByType(EdgelessTextBlockModel).length > 0,
} as const satisfies ToolbarModuleConfig;

export const edgelessTextToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier("myoxus:surface:edgeless-text"),
  config: edgelessTextToolbarConfig,
});
