import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

import { CalloutKeymapExtension } from "./callout-keymap";
import { calloutSlashMenuConfig } from "./configs/slash-menu";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { effects } from "./effects";

export class CalloutViewExtension extends ViewExtensionProvider {
  override name = "myoxus-callout-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension("myoxus:callout"),
      BlockViewExtension("myoxus:callout", "myoxus-callout"),
      CalloutKeymapExtension,
      SlashMenuConfigExtension("myoxus:callout", calloutSlashMenuConfig),
      ...createBuiltinToolbarConfigExtension("myoxus:callout"),
    ]);
  }
}
