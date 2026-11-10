import {
  patchForEdgelessNoteConfig,
  patchForEmbedSyncedDocConfig,
} from "@myoxus/core/editor/view-extensions/edgeless-block-header/patch";
import { FrameworkProvider } from "@myoxus/infra";
import type { ElementOrFactory } from "@myoxus/lit-react";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import type { TemplateResult } from "lit";
import { z } from "zod";

const optionsSchema = z.object({
  isInPeekView: z.boolean(),
  framework: z.instanceof(FrameworkProvider),
  reactToLit: z
    .function()
    .input([z.custom<ElementOrFactory>(), z.boolean().optional()], z.unknown())
    .output(z.custom<TemplateResult>()),
});

export type EdgelessBlockHeaderViewOptions = z.infer<typeof optionsSchema>;

export class EdgelessBlockHeaderConfigViewExtension extends ViewExtensionProvider<EdgelessBlockHeaderViewOptions> {
  override name = "header-config-view";
  override schema = optionsSchema;

  override setup(
    context: ViewExtensionContext,
    options?: EdgelessBlockHeaderViewOptions,
  ) {
    super.setup(context, options);
    if (!options) return;
    const { framework, isInPeekView, reactToLit } = options;

    context.register(
      patchForEdgelessNoteConfig(framework, reactToLit, isInPeekView),
    );
    context.register(patchForEmbedSyncedDocConfig(reactToLit));
  }
}
