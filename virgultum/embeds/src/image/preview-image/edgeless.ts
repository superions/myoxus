import { toNativeGfxBlockComponent } from "@virgultum/canvas-runtime/surface";
import { installEditorStyles } from "@virgultum/core/runtime";

import { ImagePlaceholderBlockComponent } from "./page.js";

const edgelessImagePlaceholderStyles = `
  myoxus-edgeless-placeholder-preview-image
    .myoxus-placeholder-preview-container {
    border: 1px solid var(--myoxus-background-tertiary-color);
  }
`;

export class ImageEdgelessPlaceholderBlockComponent extends toNativeGfxBlockComponent(
  ImagePlaceholderBlockComponent,
) {
  override connectedCallback() {
    super.connectedCallback();
    installEditorStyles(this, edgelessImagePlaceholderStyles);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-placeholder-preview-image": ImageEdgelessPlaceholderBlockComponent;
  }
}
