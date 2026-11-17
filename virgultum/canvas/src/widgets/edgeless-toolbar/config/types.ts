import type { SelectionAction } from "@virgultum/core/services";
import type { BlockComponent } from "@virgultum/core/runtime";
import type { GfxController } from "@virgultum/core/runtime/gfx";

/**
 * Helper function to build a menu configuration for a tool in dense mode
 */
export type DenseMenuBuilder = (
  edgeless: BlockComponent,
  gfx: GfxController,
) => SelectionAction;
