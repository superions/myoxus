import { FrameworkProvider } from "@myoxus/infra";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import z from "zod";

import { MyoxusCommentProvider } from "./comment-provider";

const optionsSchema = z.object({
  enableComment: z.boolean().optional(),
  framework: z.instanceof(FrameworkProvider).optional(),
});

type CommentViewOptions = z.infer<typeof optionsSchema>;

export class CommentViewExtension extends ViewExtensionProvider<CommentViewOptions> {
  override name = "comment";

  override schema = optionsSchema;

  override setup(context: ViewExtensionContext, options?: CommentViewOptions) {
    super.setup(context, options);
    if (!options?.enableComment) return;

    const framework = options.framework;
    if (!framework) return;

    context.register([MyoxusCommentProvider(framework)]);
  }
}
