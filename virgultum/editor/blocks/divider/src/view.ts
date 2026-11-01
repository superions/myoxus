import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { BlockViewExtension } from "@virgultum/std";
import { literal } from "lit/static-html.js";

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
      BlockViewExtension("myoxus:divider", literal`myoxus-divider`),
      DividerMarkdownExtension,
    ]);
  }
}
