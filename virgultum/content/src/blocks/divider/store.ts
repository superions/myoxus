import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { DividerBlockSchemaExtension } from "@virgultum/core/models";

import { DividerBlockAdapterExtensions } from "./adapters/extension";

export class DividerStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-divider-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(DividerBlockSchemaExtension);
    context.register(DividerBlockAdapterExtensions);
  }
}
