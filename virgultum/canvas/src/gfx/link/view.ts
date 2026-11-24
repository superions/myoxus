import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import { linkQuickTool } from "./link-tool";

export class LinkViewExtension extends ViewExtensionProvider {
  override name = "myoxus-link-gfx";

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    if (this.isEdgeless(context.scope)) {
      context.register(linkQuickTool);
    }
  }
}
