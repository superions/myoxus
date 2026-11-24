import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { BlockViewExtension } from "@virgultum/core/runtime";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

import { latexSlashMenuConfig } from "./configs/slash-menu";
import { effects } from "./effects";

export class LatexViewExtension extends ViewExtensionProvider {
  override name = "myoxus-latex-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      BlockViewExtension("myoxus:latex", "myoxus-latex"),
      SlashMenuConfigExtension("myoxus:latex", latexSlashMenuConfig),
    ]);
  }
}
