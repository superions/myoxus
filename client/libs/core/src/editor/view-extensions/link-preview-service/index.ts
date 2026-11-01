import { FrameworkProvider } from "@myoxus/infra";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { z } from "zod";

import { patchLinkPreviewService } from "./link-preview-service";

const optionsSchema = z.object({
  framework: z.instanceof(FrameworkProvider).optional(),
});

type MyoxusLinkPreviewViewOptions = z.infer<typeof optionsSchema>;

export class MyoxusLinkPreviewExtension extends ViewExtensionProvider<MyoxusLinkPreviewViewOptions> {
  override name = "myoxus-link-preview-extension";

  override schema = optionsSchema;

  override setup(
    context: ViewExtensionContext,
    options?: MyoxusLinkPreviewViewOptions,
  ) {
    super.setup(context, options);
    if (!options?.framework) {
      return;
    }
    const { framework } = options;
    context.register(patchLinkPreviewService(framework));
  }
}
