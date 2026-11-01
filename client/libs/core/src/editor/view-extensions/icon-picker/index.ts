import { FrameworkProvider } from "@myoxus/infra";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { z } from "zod";

import { patchIconPickerService } from "./icon-picker-service";

const optionsSchema = z.object({
  framework: z.instanceof(FrameworkProvider).optional(),
});

type MyoxusIconPickerViewOptions = z.infer<typeof optionsSchema>;

export class MyoxusIconPickerExtension extends ViewExtensionProvider<MyoxusIconPickerViewOptions> {
  override name = "myoxus-icon-picker-extension";

  override schema = optionsSchema;

  override setup(
    context: ViewExtensionContext,
    options?: MyoxusIconPickerViewOptions,
  ) {
    super.setup(context, options);
    if (!options?.framework) {
      return;
    }
    const { framework } = options;
    context.register(patchIconPickerService(framework));
  }
}
