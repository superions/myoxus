import {
  PageSurfaceBlock,
  SurfaceBlockComponent,
} from "./native-surface-block.js";

export function effects() {
  customElements.define("myoxus-surface-void", PageSurfaceBlock);
  customElements.define("myoxus-surface", SurfaceBlockComponent);
}
