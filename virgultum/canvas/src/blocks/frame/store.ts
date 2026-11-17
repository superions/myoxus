import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from "@virgultum/core/extensions";
import { FrameBlockSchemaExtension } from "@virgultum/core/models";

export class FrameStoreExtension extends StoreExtensionProvider {
  override name = "myoxus-frame-block";

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register([FrameBlockSchemaExtension]);
  }
}
