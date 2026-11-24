import type { BlockComponent } from "./block-component.js";

export const blockComponentSymbol = Symbol("blockComponent");
export function isBlockComponent(element: unknown): element is BlockComponent {
  return (element as BlockComponent | null)?.[blockComponentSymbol] === true;
}

export const WIDGET_ID_ATTR = "data-widget-id";
export const BLOCK_ID_ATTR = "data-block-id";

export { NativeViewElement } from "../../../primitives/env/index.js";
