import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { EdgelessTextBlockSchemaExtension } from "@virgultum/model";

export class EdgelessTextStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-edgeless-text-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(EdgelessTextBlockSchemaExtension);
  }
}
