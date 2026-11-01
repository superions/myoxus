import { ViewExtensionProvider } from "@virgultum/ext-loader";

import { effects } from "./effects";

export class DocTitleViewExtension extends ViewExtensionProvider {
  override name = "myoxus-doc-title-fragment";

  override effect() {
    super.effect();
    effects();
  }
}
