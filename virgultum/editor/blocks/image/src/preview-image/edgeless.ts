import { unsafeCSSVar } from "@virgultum/shared/theme";
import { toGfxBlockComponent } from "@virgultum/std";
import { css } from "lit";

import { ImagePlaceholderBlockComponent } from "./page.js";

export class ImageEdgelessPlaceholderBlockComponent extends toGfxBlockComponent(
  ImagePlaceholderBlockComponent,
) {
  static override styles = css`
    myoxus-edgeless-placeholder-preview-image
      .myoxus-placeholder-preview-container {
      border: 1px solid ${unsafeCSSVar("backgroundTertiaryColor")};
    }
  `;

  override renderGfxBlock(): unknown {
    return super.renderGfxBlock();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-placeholder-preview-image": ImageEdgelessPlaceholderBlockComponent;
  }
}
