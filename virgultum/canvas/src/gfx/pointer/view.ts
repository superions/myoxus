import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import { defaultQuickTool } from "./quick-tool/quick-tool";
import { SnapExtension, SnapOverlay } from "@virgultum/canvas-runtime/snap";
import { EmptyTool, PanTool } from "@virgultum/canvas-runtime/tools";

export class PointerViewExtension extends ViewExtensionProvider {
  override name = "myoxus-pointer-gfx";

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(EmptyTool);
    context.register(PanTool);
    if (this.isEdgeless(context.scope)) {
      context.register(defaultQuickTool);
      context.register(SnapExtension);
      context.register(SnapOverlay);
    }
  }
}
