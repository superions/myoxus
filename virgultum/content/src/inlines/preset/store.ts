import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";

import { InlineAdapterExtensions } from "./adapters/extensions";

export class InlinePresetStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-inline-preset";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(InlineAdapterExtensions);
  }
}
