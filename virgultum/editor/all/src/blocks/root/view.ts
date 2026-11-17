import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";
import { NoteBlockSchema } from "@virgultum/core/models";
import {
  ToolbarModuleExtension,
  ViewportElementExtension,
} from "@virgultum/core/services";
import {
  BlockFlavourIdentifier,
  BlockViewExtension,
  FlavourExtension,
} from "@virgultum/core/runtime";
import { literal } from "lit/static-html.js";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";
import { formattingSlashMenuConfig } from "./configs/slash-menu";

import { PageClipboard, ReadOnlyClipboard } from "./clipboard";
import { builtinToolbarConfig } from "./configs/toolbar";
import { EdgelessClipboardController, EdgelessRootService } from "./edgeless";
import { EdgelessElementToolbarExtension } from "./edgeless/configs/toolbar";
import { EdgelessLocker } from "./edgeless/edgeless-root-spec";
import { AltCloneExtension } from "./edgeless/interact-extensions/clone-ext";
import { effects } from "./effects";
import { fallbackKeymap } from "./keyboard/keymap";

export class RootViewExtension extends ViewExtensionProvider {
  override name = "myoxus-root-block";

  override effect(): void {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension("myoxus:page"),
      fallbackKeymap,
      SlashMenuConfigExtension("myoxus:formatting", formattingSlashMenuConfig),
      ToolbarModuleExtension({
        id: BlockFlavourIdentifier(NoteBlockSchema.model.flavour),
        config: builtinToolbarConfig,
      }),
    ]);
    if (
      context.scope === "preview-page" ||
      context.scope === "preview-edgeless"
    ) {
      context.register(ReadOnlyClipboard);
    }
    if (this.isEdgeless(context.scope)) {
      this._setupEdgeless(context);
      return;
    }
    this._setupPage(context);
  }

  private readonly _setupPage = (context: ViewExtensionContext) => {
    context.register(ViewportElementExtension(".myoxus-page-viewport"));
    if (context.scope === "preview-page") {
      context.register(
        BlockViewExtension("myoxus:page", literal`myoxus-preview-root`),
      );
      return;
    }
    context.register(
      BlockViewExtension("myoxus:page", literal`myoxus-page-root`),
    );
    context.register(PageClipboard);
  };

  private readonly _setupEdgeless = (context: ViewExtensionContext) => {
    context.register([
      EdgelessRootService,
      ViewportElementExtension(".myoxus-edgeless-viewport"),
    ]);
    if (context.scope === "preview-edgeless") {
      context.register([
        BlockViewExtension(
          "myoxus:page",
          literal`myoxus-edgeless-root-preview`,
        ),
        EdgelessLocker,
      ]);
      return;
    }
    context.register([
      BlockViewExtension("myoxus:page", literal`myoxus-edgeless-root`),
      EdgelessClipboardController,
      AltCloneExtension,
    ]);
    context.register(EdgelessElementToolbarExtension);
  };
}
