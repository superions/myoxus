import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import {
  EmbedLinkedDocBlockSchemaExtension,
  EmbedSyncedDocBlockSchemaExtension,
} from "@virgultum/model";

import { EmbedLinkedDocBlockAdapterExtensions } from "./embed-linked-doc-block/adapters/extension";
import { EmbedSyncedDocBlockAdapterExtensions } from "./embed-synced-doc-block/adapters/extension";

export class EmbedDocStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-embed-doc-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([
      EmbedSyncedDocBlockSchemaExtension,
      EmbedLinkedDocBlockSchemaExtension,
    ]);
    context.register(EmbedLinkedDocBlockAdapterExtensions);
    context.register(EmbedSyncedDocBlockAdapterExtensions);
  }
}
