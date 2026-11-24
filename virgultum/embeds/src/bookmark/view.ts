import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { BookmarkBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";

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
          ? "myoxus-edgeless-bookmark"
          : "myoxus-bookmark";
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
