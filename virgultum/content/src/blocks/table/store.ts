import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { TableBlockSchemaExtension } from "@virgultum/core/models";

import { TableBlockAdapterExtensions } from "./adapters/extension";
import { TableSelectionExtension } from "./selection-schema";

export class TableStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-table-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(TableBlockSchemaExtension);
    context.register(TableBlockAdapterExtensions);
    context.register(TableSelectionExtension);
  }
}
