import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { AttachmentBlockSchemaExtension } from "@virgultum/model";

import { AttachmentBlockAdapterExtensions } from "./adapters/extension";

export class AttachmentStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-attachment-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(AttachmentBlockSchemaExtension);
    context.register(AttachmentBlockAdapterExtensions);
  }
}
