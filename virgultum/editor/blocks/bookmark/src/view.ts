import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { BookmarkBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import { literal } from "lit/static-html.js";

import { BookmarkBlockInteraction } from "./bookmark-edgeless-block";
import { BookmarkSlashMenuConfigExtension } from "./configs/slash-menu";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EdgelessClipboardBookmarkConfig } from "./edgeless-clipboard-config";
import { effects } from "./effects";

const flavour = BookmarkBlockSchema.model.flavour;

export class BookmarkViewExtension extends ViewExtensionProvider {
  override name = "myoxus-bookmark-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension(flavour),
      BlockViewExtension(flavour, (model) => {
        return model.parent?.flavour === "myoxus:surface"
          ? literal`myoxus-edgeless-bookmark`
          : literal`myoxus-bookmark`;
      }),
      BookmarkSlashMenuConfigExtension,
    ]);
    context.register(createBuiltinToolbarConfigExtension(flavour));
    const isEdgeless = this.isEdgeless(context.scope);
    if (isEdgeless) {
      context.register(EdgelessClipboardBookmarkConfig);
      context.register(BookmarkBlockInteraction);
    }
  }
}
