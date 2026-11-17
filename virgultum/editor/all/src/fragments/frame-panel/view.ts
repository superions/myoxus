import { ViewExtensionProvider } from "@virgultum/core/extensions";

import { effects } from "./effects";

export class FramePanelViewExtension extends ViewExtensionProvider {
  override name = "myoxus-frame-panel-fragment";

  override effect() {
    super.effect();
    effects();
  }
}
