import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/ext-loader";
import { SurfaceRefBlockSchemaExtension } from "@virgultum/model";

export class SurfaceRefStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-surface-ref-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(SurfaceRefBlockSchemaExtension);
  }
}
