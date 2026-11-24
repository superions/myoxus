import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { BlockViewExtension } from "@virgultum/core/runtime";

import { effects } from "./effects";
import { DividerMarkdownExtension } from "./markdown";

export class DividerViewExtension extends ViewExtensionProvider {
  override name = "myoxus-divider-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      BlockViewExtension("myoxus:divider", "myoxus-divider"),
      DividerMarkdownExtension,
    ]);
  }
}
