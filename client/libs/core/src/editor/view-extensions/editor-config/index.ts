import { getEditorConfigExtension } from "@myoxus/core/editor/view-extensions/editor-config/get-config";
import { FrameworkProvider } from "@myoxus/infra";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { z } from "zod";

const optionsSchema = z.object({
  framework: z.instanceof(FrameworkProvider).optional(),
});

type MyoxusEditorConfigViewOptions = z.infer<typeof optionsSchema>;

export class MyoxusEditorConfigViewExtension extends ViewExtensionProvider<MyoxusEditorConfigViewOptions> {
  override name = "myoxus-view-editor-config";

  override schema = optionsSchema;

  override setup(
    context: ViewExtensionContext,
    options?: MyoxusEditorConfigViewOptions,
  ) {
    super.setup(context, options);
    const framework = options?.framework;
    if (!framework) {
      return;
    }

    if (context.scope === "edgeless" || context.scope === "page") {
      context.register(getEditorConfigExtension(framework));
    }
  }
}
