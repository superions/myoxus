// SPDX-License-Identifier: MIT

// Model consumers must not evaluate the controller, tool or DOM-view entries.
export * from "./base";
export * from "./gfx-block-model";
export * from "./model";
export * from "./surface/decorators/index";
export * from "./surface/element-model";
export * from "./surface/local-element-model";
export * from "./surface/surface-model";
export {
  batchAddChildren,
  batchRemoveChildren,
  canSafeAddToContainer,
  descendantElementsImpl,
  getTopElements,
  hasDescendantElementImpl,
} from "../../utils/tree";
export { GfxCompatibleBlockModel as GfxCompatible } from "./gfx-block-model";
export { generateKeyBetweenV2 } from "../../utils/fractional-indexing";
