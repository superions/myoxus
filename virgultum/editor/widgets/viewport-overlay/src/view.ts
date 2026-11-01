import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { effects } from "./effects";
import { viewportOverlayWidget } from "./index";

export class ViewportOverlayViewExtension extends ViewExtensionProvider {
  override name = "myoxus-viewport-overlay-widget";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(viewportOverlayWidget);
  }
}
