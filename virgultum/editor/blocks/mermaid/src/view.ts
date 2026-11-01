import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import {
  mermaidSelectionToolbarExtensions,
  mermaidSeniorTool,
} from "./edgeless-toolbar/index.js";
import { MermaidEdgelessInsertionShortcuts } from "./edgeless-toolbar/insertion-shortcuts.js";
import { effects } from "./effects.js";
import { MermaidBlockSpec, MermaidEdgelessBlockSpec } from "./mermaid-spec.js";
import { MermaidEdgelessClipboardConfig } from "./presentation/edgeless-clipboard-config.js";

export class MermaidViewExtension extends ViewExtensionProvider {
  override name = "myoxus-mermaid-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(MermaidBlockSpec);
    if (this.isEdgeless(context.scope)) {
      context.register(MermaidEdgelessBlockSpec);
      context.register(MermaidEdgelessClipboardConfig);
      context.register(mermaidSeniorTool);
      context.register(MermaidEdgelessInsertionShortcuts);
      context.register(mermaidSelectionToolbarExtensions);
    }
  }
}
