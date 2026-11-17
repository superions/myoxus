import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { AttachmentBlockSchemaExtension } from "@virgultum/core/models";

import { AttachmentBlockAdapterExtensions } from "./adapters/extension";

export class AttachmentStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-attachment-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(AttachmentBlockSchemaExtension);
    context.register(AttachmentBlockAdapterExtensions);
  }
}
