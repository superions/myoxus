import type { Rect } from "../../primitives/gfx/index";
import type { BlockComponent } from "../../runtime/index";
import type { BlockModel } from "../../store/index";

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
