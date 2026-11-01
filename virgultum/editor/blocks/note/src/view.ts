import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { NoteBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import { literal } from "lit/static-html.js";

import { NoteSlashMenuConfigExtension } from "./configs/slash-menu";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EdgelessClipboardNoteConfig } from "./edgeless-clipboard-config";
import { effects } from "./effects";
import { EdgelessNoteInteraction } from "./note-edgeless-block";
import { NoteKeymapExtension } from "./note-keymap";

const flavour = NoteBlockSchema.model.flavour;

export class NoteViewExtension extends ViewExtensionProvider {
  override name = "myoxus-note-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension(flavour),
      NoteSlashMenuConfigExtension,
      NoteKeymapExtension,
    ]);

    const isEdgeless = this.isEdgeless(context.scope);

    if (isEdgeless) {
      context.register(
        BlockViewExtension(flavour, literal`myoxus-edgeless-note`),
      );
      context.register(createBuiltinToolbarConfigExtension(flavour));
      context.register(EdgelessClipboardNoteConfig);
      context.register(EdgelessNoteInteraction);
    } else {
      context.register(BlockViewExtension(flavour, literal`myoxus-note`));
    }
  }
}

export { FootnoteDefinitionViewExtension } from "./footnote-definition";
