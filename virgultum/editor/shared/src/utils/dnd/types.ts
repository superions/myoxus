import type { Rect } from "@virgultum/global/gfx";
import type { BlockComponent } from "@virgultum/std";
import type { BlockModel } from "@virgultum/store";

export interface EditingState {
  element: BlockComponent;
  model: BlockModel;
  rect: DOMRect;
}

/**
 * Returns a flag for the drop target.
 */
export enum DropFlags {
  Normal,
  Database,
  EmptyDatabase,
}

/**
 * A drop placement.
 */
export type DropPlacement = "none" | "before" | "after" | "database" | "in";

export type DropTarget = {
  placement: DropPlacement;
  rect: Rect;
  modelState: EditingState;
};
