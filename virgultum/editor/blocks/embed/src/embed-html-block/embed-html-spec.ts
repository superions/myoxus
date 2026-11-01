import { EmbedHtmlBlockSchema } from "@virgultum/model";
import { BlockViewExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { literal } from "lit/static-html.js";

import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EmbedEdgelessHtmlBlockInteraction } from "./embed-edgeless-html-block";

const flavour = EmbedHtmlBlockSchema.model.flavour;

export const EmbedHtmlViewExtensions: ExtensionType[] = [
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? literal`myoxus-embed-edgeless-html-block`
      : literal`myoxus-embed-html-block`;
  }),
  createBuiltinToolbarConfigExtension(flavour),
  EmbedEdgelessHtmlBlockInteraction,
].flat();
