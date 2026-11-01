import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { BlockViewExtension } from "@virgultum/std";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

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
      BlockViewExtension("myoxus:latex", literal`myoxus-latex`),
      SlashMenuConfigExtension("myoxus:latex", latexSlashMenuConfig),
    ]);
  }
}
