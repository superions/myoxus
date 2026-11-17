export {
  HighlightSelection,
  HighlightSelectionExtension,
} from "./hightlight.js";
export { ImageSelection, ImageSelectionExtension } from "./image.js";

// Selection data/DI bindings are also used before any editor view is mounted.
export * from "../runtime/selection/index";
