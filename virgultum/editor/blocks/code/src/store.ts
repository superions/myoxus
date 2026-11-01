import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { CodeBlockSchemaExtension } from "@virgultum/model";

import { CodeBlockAdapterExtensions } from "./adapters/extension";
import { CodeMarkdownPreprocessorExtension } from "./adapters/markdown/preprocessor";

export class CodeStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-code-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(CodeBlockSchemaExtension);
    context.register(CodeBlockAdapterExtensions);
    context.register(CodeMarkdownPreprocessorExtension);
  }
}
