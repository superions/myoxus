import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import { effects } from "./effects";
import { FrameTitleIdentifier } from "./mount-frame-title";

export class FrameTitleViewExtension extends ViewExtensionProvider {
  override name = "myoxus-frame-title-widget";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    if (context.scope === "edgeless") {
      context.register({
        setup: (di) => di.addImpl(FrameTitleIdentifier, () => true),
      });
    }
  }
}
