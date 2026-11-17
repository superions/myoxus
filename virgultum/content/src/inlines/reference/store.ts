import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";

import {
  referenceDeltaMarkdownAdapterMatch,
  referenceDeltaToHtmlAdapterMatcher,
  referenceDeltaToMarkdownAdapterMatcher,
} from "./adapters/index";

export class ReferenceStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-reference-inline";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(referenceDeltaToHtmlAdapterMatcher);
    context.register(referenceDeltaToMarkdownAdapterMatcher);
    context.register(referenceDeltaMarkdownAdapterMatch);
  }
}
