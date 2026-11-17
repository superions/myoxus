import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";

import {
  htmlLinkElementToDeltaMatcher,
  linkDeltaMarkdownAdapterMatch,
  linkDeltaToHtmlAdapterMatcher,
  linkDeltaToMarkdownAdapterMatcher,
  markdownLinkToDeltaMatcher,
  notionHtmlLinkElementToDeltaMatcher,
} from "./adapters/index";

export class LinkStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-link-inline";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(linkDeltaMarkdownAdapterMatch);
    context.register(linkDeltaToMarkdownAdapterMatcher);
    context.register(notionHtmlLinkElementToDeltaMatcher);
    context.register(markdownLinkToDeltaMatcher);
    context.register(htmlLinkElementToDeltaMatcher);
    context.register(linkDeltaToHtmlAdapterMatcher);
  }
}
