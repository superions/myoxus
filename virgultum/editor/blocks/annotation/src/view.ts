// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";
import { AnnotationBlockComponent } from "./annotation-block";
import { annotationSlashMenuConfig } from "./slash-menu";
import { annotationToolbarExtension } from "./toolbar";

export class AnnotationViewExtension extends ViewExtensionProvider {
  override name = "myoxus-annotation-block";
  override effect() {
    super.effect();
    customElements.define("myoxus-annotation", AnnotationBlockComponent);
  }
  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension("myoxus:annotation"),
      BlockViewExtension("myoxus:annotation", literal`myoxus-annotation`),
      SlashMenuConfigExtension("myoxus:annotation", annotationSlashMenuConfig),
      annotationToolbarExtension,
    ]);
  }
}
