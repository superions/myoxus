import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { RootBlockSchemaExtension } from "@virgultum/core/models";

import { RootBlockAdapterExtensions } from "./adapters/extension";

export class RootStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-root-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(RootBlockSchemaExtension);
    context.register(RootBlockAdapterExtensions);
  }
}
