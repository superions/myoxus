import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import { NoteTool } from "./note-tool";
import { noteSeniorTool } from "./toolbar/senior-tool";

export class NoteViewExtension extends ViewExtensionProvider {
  override name = "myoxus-note-gfx";

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(NoteTool);
    context.register(noteSeniorTool);
  }
}
