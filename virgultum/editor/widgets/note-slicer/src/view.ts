import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { effects } from "./effects";
import { noteSlicerWidget } from "./note-slicer";

export class NoteSlicerViewExtension extends ViewExtensionProvider {
  override name = "myoxus-note-slicer-widget";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    if (this.isEdgeless(context.scope)) {
      context.register(noteSlicerWidget);
    }
  }
}
