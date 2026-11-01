import { ViewExtensionProvider } from "@virgultum/ext-loader";

import { effects } from "./effects";

export class FramePanelViewExtension extends ViewExtensionProvider {
  override name = "myoxus-frame-panel-fragment";

  override effect() {
    super.effect();
    effects();
  }
}
