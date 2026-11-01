import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { DefaultInlineManagerExtension } from "./default-inline-manager";
import { effects } from "./effects";
import { InlineSpecExtensions } from "./inline-spec";
import { MarkdownExtensions } from "./markdown";

export class InlinePresetViewExtension extends ViewExtensionProvider {
  override name = "myoxus-inline-preset";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(DefaultInlineManagerExtension);
    context.register(InlineSpecExtensions);
    context.register(MarkdownExtensions);
  }
}
