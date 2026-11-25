import type { MountReactPortal } from "@myoxus/core/editor/portal";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { z } from "zod";

import { patchForPDFEmbedView } from "./pdf-view";

const optionsSchema = z.object({
  mountPortal: z.optional(z.custom<MountReactPortal>()),
});

type PdfViewOptions = z.infer<typeof optionsSchema>;

export class PdfViewExtension extends ViewExtensionProvider<PdfViewOptions> {
  override name = "myoxus-view-pdf";

  override schema = optionsSchema;

  override setup(context: ViewExtensionContext, options?: PdfViewOptions) {
    super.setup(context, options);
    const mountPortal = options?.mountPortal;
    if (!mountPortal) {
      return;
    }

    context.register(patchForPDFEmbedView(mountPortal));
  }
}
