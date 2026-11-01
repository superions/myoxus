import type { ElementOrFactory } from "@myoxus/lit-react";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import type { TemplateResult } from "lit";
import { z } from "zod";

import { patchForPDFEmbedView } from "./pdf-view";

const optionsSchema = z.object({
  reactToLit: z.optional(
    z
      .function()
      .args(z.custom<ElementOrFactory>(), z.boolean().optional())
      .returns(z.custom<TemplateResult>()),
  ),
});

type PdfViewOptions = z.infer<typeof optionsSchema>;

export class PdfViewExtension extends ViewExtensionProvider<PdfViewOptions> {
  override name = "myoxus-view-pdf";

  override schema = optionsSchema;

  override setup(context: ViewExtensionContext, options?: PdfViewOptions) {
    super.setup(context, options);
    const reactToLit = options?.reactToLit;
    if (!reactToLit) {
      return;
    }

    context.register(patchForPDFEmbedView(reactToLit));
  }
}
