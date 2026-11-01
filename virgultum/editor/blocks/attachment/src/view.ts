import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { AttachmentBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

import { AttachmentBlockInteraction } from "./attachment-edgeless-block.js";
import { AttachmentDropOption } from "./attachment-service.js";
import { attachmentSlashMenuConfig } from "./configs/slash-menu.js";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EdgelessClipboardAttachmentConfig } from "./edgeless-clipboard-config";
import { effects } from "./effects.js";
import {
  AttachmentEmbedConfigExtension,
  AttachmentEmbedService,
} from "./embed";

const flavour = AttachmentBlockSchema.model.flavour;

export class AttachmentViewExtension extends ViewExtensionProvider {
  override name = "myoxus-attachment-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension(flavour),
      BlockViewExtension(flavour, (model) => {
        return model.parent?.flavour === "myoxus:surface"
          ? literal`myoxus-edgeless-attachment`
          : literal`myoxus-attachment`;
      }),
      AttachmentDropOption,
      AttachmentEmbedConfigExtension(),
      AttachmentEmbedService,
      SlashMenuConfigExtension(flavour, attachmentSlashMenuConfig),
      ...createBuiltinToolbarConfigExtension(flavour),
    ]);
    if (this.isEdgeless(context.scope)) {
      context.register(EdgelessClipboardAttachmentConfig);
      context.register(AttachmentBlockInteraction);
    }
  }
}
