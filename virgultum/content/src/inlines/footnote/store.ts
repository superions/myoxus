import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";

import {
  footnoteReferenceDeltaToMarkdownAdapterMatcher,
  FootnoteReferenceMarkdownPreprocessorExtension,
  markdownFootnoteReferenceToDeltaMatcher,
  localFootnoteDeltaToHtml,
  localFootnoteHtmlToDelta,
  localFootnoteDeltaToPlainText,
} from "./adapters/index";

export class FootnoteStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-footnote-inline";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(markdownFootnoteReferenceToDeltaMatcher);
    context.register(footnoteReferenceDeltaToMarkdownAdapterMatcher);
    context.register(FootnoteReferenceMarkdownPreprocessorExtension);
    context.register(localFootnoteDeltaToHtml);
    context.register(localFootnoteHtmlToDelta);
    context.register(localFootnoteDeltaToPlainText);
  }
}
