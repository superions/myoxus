import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import { literal } from "lit/static-html.js";

import { effects } from "./effects.js";
import { ListKeymapExtension, ListTextKeymapExtension } from "./list-keymap.js";
import { ListMarkdownExtension } from "./markdown.js";

export class ListViewExtension extends ViewExtensionProvider {
  override name = "myoxus-list-block";

  override effect(): void {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension("myoxus:list"),
      BlockViewExtension("myoxus:list", literal`myoxus-list`),
      ListKeymapExtension,
      ListTextKeymapExtension,
      ListMarkdownExtension,
    ]);
  }
}
