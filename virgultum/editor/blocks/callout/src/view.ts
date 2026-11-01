import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

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
      BlockViewExtension("myoxus:callout", literal`myoxus-callout`),
      CalloutKeymapExtension,
      SlashMenuConfigExtension("myoxus:callout", calloutSlashMenuConfig),
      ...createBuiltinToolbarConfigExtension("myoxus:callout"),
    ]);
  }
}
