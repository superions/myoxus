import { ViewExtensionProvider } from "@virgultum/core/extensions";

import { effects } from "./effects";

export class DocTitleViewExtension extends ViewExtensionProvider {
  override name = "myoxus-doc-title-fragment";

  override effect() {
    super.effect();
    effects();
  }
}
