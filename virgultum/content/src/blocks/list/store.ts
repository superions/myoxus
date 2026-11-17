import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { ListBlockSchemaExtension } from "@virgultum/core/models";

import { ListBlockAdapterExtensions } from "./adapters/extension";

export class ListStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-list-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(ListBlockSchemaExtension);
    context.register(ListBlockAdapterExtensions);
  }
}
