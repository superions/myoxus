import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { SurfaceRefBlockSchema } from "@virgultum/model";
import { ToolbarModuleExtension } from "@virgultum/shared/services";
import {
  BlockFlavourIdentifier,
  BlockViewExtension,
  FlavourExtension,
} from "@virgultum/std";
import { literal } from "lit/static-html.js";

import { SurfaceRefSlashMenuConfigExtension } from "./configs/slash-menu";
import { surfaceRefToolbarModuleConfig } from "./configs/toolbar";
import { effects } from "./effects";

const flavour = SurfaceRefBlockSchema.model.flavour;

export class SurfaceRefViewExtension extends ViewExtensionProvider {
  override name = "myoxus-surface-ref-block";

  override effect(): void {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext): void {
    super.setup(context);
    context.register([
      FlavourExtension(flavour),
      SurfaceRefSlashMenuConfigExtension,
    ]);
    const isEdgeless = this.isEdgeless(context.scope);
    if (isEdgeless) {
      context.register([
        BlockViewExtension(flavour, literal`myoxus-edgeless-surface-ref`),
      ]);
    } else {
      context.register([
        BlockViewExtension(flavour, literal`myoxus-surface-ref`),
        ToolbarModuleExtension({
          id: BlockFlavourIdentifier(flavour),
          config: surfaceRefToolbarModuleConfig,
        }),
      ]);
    }
  }
}
