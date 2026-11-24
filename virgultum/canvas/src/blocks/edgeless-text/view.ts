import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { BlockViewExtension } from "@virgultum/core/runtime";

import { EdgelessClipboardEdgelessTextConfig } from "./edgeless-clipboard-config";
import { EdgelessTextInteraction } from "./edgeless-text-block";
import { edgelessTextToolbarExtension } from "./edgeless-toolbar";
import { effects } from "./effects";

export class EdgelessTextViewExtension extends ViewExtensionProvider {
  override name = "myoxus-edgeless-text-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    const isEdgeless = this.isEdgeless(context.scope);

    if (isEdgeless) {
      context.register([
        BlockViewExtension("myoxus:edgeless-text", "myoxus-edgeless-text"),
      ]);
      context.register(edgelessTextToolbarExtension);
      context.register(EdgelessClipboardEdgelessTextConfig);
      context.register(EdgelessTextInteraction);
    }
  }
}
