import { EmbedLinkedDocBlockSchema } from "@virgultum/model";
import { BlockViewExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { literal } from "lit/static-html.js";

import { LinkedDocSlashMenuConfigExtension } from "./configs/slash-menu";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EmbedLinkedDocInteraction } from "./embed-edgeless-linked-doc-block";

const flavour = EmbedLinkedDocBlockSchema.model.flavour;

export const EmbedLinkedDocViewExtensions: ExtensionType[] = [
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? literal`myoxus-embed-edgeless-linked-doc-block`
      : literal`myoxus-embed-linked-doc-block`;
  }),
  createBuiltinToolbarConfigExtension(flavour),
  EmbedLinkedDocInteraction,
  LinkedDocSlashMenuConfigExtension,
].flat();
