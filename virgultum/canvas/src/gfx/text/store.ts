import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";

import {
  textToMarkdownAdapterMatcher,
  textToPlainTextAdapterMatcher,
} from "./adapter";

export class TextStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-text-gfx";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(textToMarkdownAdapterMatcher);
    context.register(textToPlainTextAdapterMatcher);
  }
}
