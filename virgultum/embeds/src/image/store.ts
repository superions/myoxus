import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { ImageBlockSchemaExtension } from "@virgultum/core/models";
import { ImageSelectionExtension } from "@virgultum/core/selection";

import { ImageBlockAdapterExtensions } from "./adapters/extension";

export class ImageStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-image-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([ImageBlockSchemaExtension, ImageSelectionExtension]);
    context.register(ImageBlockAdapterExtensions);
  }
}
