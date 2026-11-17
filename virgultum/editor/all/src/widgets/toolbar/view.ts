import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import { toolbarWidget } from ".";
import { effects } from "./effects";

export class ToolbarViewExtension extends ViewExtensionProvider {
  override name = "myoxus-toolbar-widget";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    if (this.isMobile(context.scope)) return;
    context.register(toolbarWidget);
  }
}
