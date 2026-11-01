import { ImageBlockFallbackCard } from "./components/image-block-fallback.js";
import { ImageBlockPageComponent } from "./components/page-image-block.js";
import { ImageBlockComponent } from "./image-block.js";
import { ImageEdgelessBlockComponent } from "./image-edgeless-block.js";
import { ImageEdgelessPlaceholderBlockComponent } from "./preview-image/edgeless.js";
import { ImagePlaceholderBlockComponent } from "./preview-image/page.js";

export function effects() {
  customElements.define("myoxus-image", ImageBlockComponent);
  customElements.define("myoxus-edgeless-image", ImageEdgelessBlockComponent);
  customElements.define("myoxus-page-image", ImageBlockPageComponent);
  customElements.define("myoxus-image-fallback-card", ImageBlockFallbackCard);
  customElements.define(
    "myoxus-placeholder-preview-image",
    ImagePlaceholderBlockComponent,
  );
  customElements.define(
    "myoxus-edgeless-placeholder-preview-image",
    ImageEdgelessPlaceholderBlockComponent,
  );
}
