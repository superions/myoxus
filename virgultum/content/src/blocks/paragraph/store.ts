import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { ParagraphBlockSchemaExtension } from "@virgultum/core/models";

import { ParagraphBlockAdapterExtensions } from "./adapters/extension";

export class ParagraphStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-paragraph-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(ParagraphBlockSchemaExtension);
    context.register(ParagraphBlockAdapterExtensions);
  }
}
