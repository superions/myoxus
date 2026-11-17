import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { BookmarkBlockSchemaExtension } from "@virgultum/core/models";

import { BookmarkBlockAdapterExtensions } from "./adapters/extension";

export class BookmarkStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-bookmark-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(BookmarkBlockSchemaExtension);
    context.register(BookmarkBlockAdapterExtensions);
  }
}
