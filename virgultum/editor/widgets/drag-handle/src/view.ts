import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { dragHandleWidget } from ".";
import { effects } from "./effects";

export class DragHandleViewExtension extends ViewExtensionProvider {
  override name = "myoxus-drag-handle-widget";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(dragHandleWidget);
  }
}
