import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { LatexBlockSchemaExtension } from "@virgultum/core/models";

import { LatexBlockAdapterExtensions } from "./adapters/extension";
import { LatexMarkdownPreprocessorExtension } from "./adapters/markdown/preprocessor";

export class LatexStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-latex-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([LatexBlockSchemaExtension]);
    context.register(LatexBlockAdapterExtensions);
    context.register(LatexMarkdownPreprocessorExtension);
  }
}
