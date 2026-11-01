import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { TableBlockSchemaExtension } from "@virgultum/model";

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
