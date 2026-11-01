import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";

import { DataViewBlockSchemaExtension } from "./data-view-model";
import { DataViewBlockSelectionExtension } from "./selection";

export class DataViewStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-data-view-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([
      DataViewBlockSchemaExtension,
      DataViewBlockSelectionExtension,
    ]);
  }
}
