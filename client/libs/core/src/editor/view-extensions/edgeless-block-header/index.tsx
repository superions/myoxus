import {
  patchForEdgelessNoteConfig,
  patchForEmbedSyncedDocConfig,
} from "@myoxus/core/editor/view-extensions/edgeless-block-header/patch";
import { FrameworkProvider } from "@myoxus/infra";
import type { MountReactPortal } from "@myoxus/core/editor/portal";
import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/editor/ext-loader";
import { z } from "zod";

const optionsSchema = z.object({
  isInPeekView: z.boolean(),
  framework: z.instanceof(FrameworkProvider),
  mountPortal: z.custom<MountReactPortal>(),
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
    const { framework, isInPeekView, mountPortal } = options;

    context.register(
      patchForEdgelessNoteConfig(framework, mountPortal, isInPeekView),
    );
    context.register(patchForEmbedSyncedDocConfig(mountPortal));
  }
}
