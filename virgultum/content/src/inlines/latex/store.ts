import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";

import {
  latexDeltaMarkdownAdapterMatch,
  latexDeltaToMarkdownAdapterMatcher,
  markdownInlineMathToDeltaMatcher,
} from "./adapters/index";
import { htmlLatexToDelta, latexDeltaToHtml } from "./adapters/html";

export class LatexStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-latex-inline";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(latexDeltaMarkdownAdapterMatch);
    context.register(latexDeltaToMarkdownAdapterMatcher);
    context.register(markdownInlineMathToDeltaMatcher);
    context.register(htmlLatexToDelta);
    context.register(latexDeltaToHtml);
  }
}
