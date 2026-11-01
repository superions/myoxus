import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { RootBlockSchemaExtension } from "@virgultum/model";

import { RootBlockAdapterExtensions } from "./adapters/extension";

export class RootStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-root-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(RootBlockSchemaExtension);
    context.register(RootBlockAdapterExtensions);
  }
}
