import { SurfaceRefPlaceHolder } from "./components";
import { SurfaceRefBlockComponent } from "./surface-ref-block";
import { EdgelessSurfaceRefBlockComponent } from "./surface-ref-block-edgeless";

export function effects() {
  customElements.define("myoxus-surface-ref", SurfaceRefBlockComponent);
  customElements.define(
    "myoxus-edgeless-surface-ref",
    EdgelessSurfaceRefBlockComponent,
  );
  customElements.define("surface-ref-placeholder", SurfaceRefPlaceHolder);
}
