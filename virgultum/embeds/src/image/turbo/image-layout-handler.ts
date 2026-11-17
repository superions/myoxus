import {
  BlockLayoutHandlerExtension,
  BlockLayoutHandlersIdentifier,
  type Rect,
} from "@virgultum/canvas-runtime/renderer";
import type { Container } from "@virgultum/core/primitives/di";
import type { EditorHost, GfxBlockComponent } from "@virgultum/core/runtime";
import {
  clientToModelCoord,
  type ViewportRecord,
} from "@virgultum/core/runtime/gfx";
import type { BlockModel } from "@virgultum/core/store";

import type { ImageLayout } from "./image-painter.worker";

export class ImageLayoutHandlerExtension extends BlockLayoutHandlerExtension<ImageLayout> {
  readonly blockType = "myoxus:image";

  static override setup(di: Container) {
    di.addImpl(
      BlockLayoutHandlersIdentifier("image"),
      ImageLayoutHandlerExtension,
    );
  }

  override queryLayout(
    model: BlockModel,
    host: EditorHost,
    viewportRecord: ViewportRecord,
  ): ImageLayout | null {
    const component = host.std.view.getBlock(
      model.id,
    ) as GfxBlockComponent | null;
    if (!component) return null;

    const imageContainer = component.querySelector(".myoxus-image-container");
    if (!imageContainer) return null;

    const resizableImg = component.querySelector(
      ".resizable-img",
    ) as HTMLElement;
    if (!resizableImg) return null;

    const { zoom, viewScale } = viewportRecord;
    const rect = resizableImg.getBoundingClientRect();

    const [modelX, modelY] = clientToModelCoord(viewportRecord, [
      rect.x,
      rect.y,
    ]);

    const imageLayout: ImageLayout = {
      type: "myoxus:image",
      blockId: model.id,
      rect: {
        x: modelX,
        y: modelY,
        w: rect.width / zoom / viewScale,
        h: rect.height / zoom / viewScale,
      },
    };

    return imageLayout;
  }

  calculateBound(layout: ImageLayout) {
    const rect: Rect = layout.rect;

    return {
      rect,
      subRects: [rect],
    };
  }
}
