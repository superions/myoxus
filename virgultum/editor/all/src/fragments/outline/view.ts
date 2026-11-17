import { ViewExtensionProvider } from "@virgultum/core/extensions";

import { effects } from "./effects";

export class OutlineViewExtension extends ViewExtensionProvider {
  override name = "myoxus-outline-fragment";

  override effect() {
    super.effect();
    effects();
  }
}
