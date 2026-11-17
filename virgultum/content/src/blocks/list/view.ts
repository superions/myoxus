import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import { literal } from "lit/static-html.js";

import { effects } from "./effects";
import { ListKeymapExtension, ListTextKeymapExtension } from "./list-keymap";
import { ListMarkdownExtension } from "./markdown";

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
