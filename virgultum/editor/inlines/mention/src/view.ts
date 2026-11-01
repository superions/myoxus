import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { effects } from "./effects";
import { MentionInlineSpecExtension } from "./inline-spec";

export class MentionViewExtension extends ViewExtensionProvider {
  override name = "myoxus-mention-inline";

  override effect(): void {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext): void {
    super.setup(context);
    context.register(MentionInlineSpecExtension);
  }
}
