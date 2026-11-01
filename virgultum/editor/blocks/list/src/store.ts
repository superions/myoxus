import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { ListBlockSchemaExtension } from "@virgultum/model";

import { ListBlockAdapterExtensions } from "./adapters/extension";

export class ListStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-list-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(ListBlockSchemaExtension);
    context.register(ListBlockAdapterExtensions);
  }
}
