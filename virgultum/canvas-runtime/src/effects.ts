import { SurfaceBlockComponent } from "./surface-block.js";
import { SurfaceBlockVoidComponent } from "./surface-block-void.js";

export function effects() {
  customElements.define("myoxus-surface-void", SurfaceBlockVoidComponent);
  customElements.define("myoxus-surface", SurfaceBlockComponent);
}
