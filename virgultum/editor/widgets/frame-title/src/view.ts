import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { effects } from "./effects";
import { frameTitleWidget } from "./myoxus-frame-title-widget";

export class FrameTitleViewExtension extends ViewExtensionProvider {
  override name = "myoxus-frame-title-widget";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    if (context.scope === "edgeless") {
      context.register(frameTitleWidget);
    }
  }
}
