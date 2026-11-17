import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { SurfaceRefBlockSchemaExtension } from "@virgultum/core/models";

export class SurfaceRefStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-surface-ref-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(SurfaceRefBlockSchemaExtension);
  }
}
