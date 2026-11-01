import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { effects } from "./effects";
import { LinkInlineSpecExtension } from "./inline-spec";
import { linkToolbar } from "./toolbar";

export class LinkViewExtension extends ViewExtensionProvider {
  override name = "myoxus-link-inline";

  override effect(): void {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext): void {
    super.setup(context);
    context.register(LinkInlineSpecExtension);
    context.register(linkToolbar);
  }
}
