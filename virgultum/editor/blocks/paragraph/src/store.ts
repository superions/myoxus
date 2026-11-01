import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { ParagraphBlockSchemaExtension } from "@virgultum/model";

import { ParagraphBlockAdapterExtensions } from "./adapters/extension";

export class ParagraphStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-paragraph-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(ParagraphBlockSchemaExtension);
    context.register(ParagraphBlockAdapterExtensions);
  }
}
