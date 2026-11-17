import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { EdgelessTextBlockSchemaExtension } from "@virgultum/core/models";

export class EdgelessTextStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-edgeless-text-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(EdgelessTextBlockSchemaExtension);
  }
}
