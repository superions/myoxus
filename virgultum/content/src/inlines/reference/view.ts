import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import { effects } from "./effects";
import { ReferenceInlineSpecExtension } from "./inline-spec";
import { RefNodeSlotsExtension } from "./reference-node/index";
import { referenceNodeToolbar } from "./toolbar";

export class ReferenceViewExtension extends ViewExtensionProvider {
  override name = "myoxus-reference-inline";

  override effect(): void {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(referenceNodeToolbar);
    context.register(ReferenceInlineSpecExtension);
    context.register(RefNodeSlotsExtension);
  }
}
