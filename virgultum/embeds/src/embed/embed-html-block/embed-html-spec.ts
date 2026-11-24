import { EmbedHtmlBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";

import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EmbedEdgelessHtmlBlockInteraction } from "./embed-edgeless-html-block";

const flavour = EmbedHtmlBlockSchema.model.flavour;

export const EmbedHtmlViewExtensions: ExtensionType[] = [
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? "myoxus-embed-edgeless-html-block"
      : "myoxus-embed-html-block";
  }),
  createBuiltinToolbarConfigExtension(flavour),
  EmbedEdgelessHtmlBlockInteraction,
].flat();
