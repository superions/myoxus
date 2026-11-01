import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { ImageBlockSchemaExtension } from "@virgultum/model";
import { ImageSelectionExtension } from "@virgultum/shared/selection";

import { ImageBlockAdapterExtensions } from "./adapters/extension";

export class ImageStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-image-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([ImageBlockSchemaExtension, ImageSelectionExtension]);
    context.register(ImageBlockAdapterExtensions);
  }
}
