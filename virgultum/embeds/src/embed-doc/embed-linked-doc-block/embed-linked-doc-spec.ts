import { EmbedLinkedDocBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";

import { LinkedDocSlashMenuConfigExtension } from "./configs/slash-menu";
import { createBuiltinToolbarConfigExtension } from "./configs/toolbar";
import { EmbedLinkedDocInteraction } from "./embed-edgeless-linked-doc-block";

const flavour = EmbedLinkedDocBlockSchema.model.flavour;

export const EmbedLinkedDocViewExtensions: ExtensionType[] = [
  BlockViewExtension(flavour, (model) => {
    return model.parent?.flavour === "myoxus:surface"
      ? "myoxus-embed-edgeless-linked-doc-block"
      : "myoxus-embed-linked-doc-block";
  }),
  createBuiltinToolbarConfigExtension(flavour),
  EmbedLinkedDocInteraction,
  LinkedDocSlashMenuConfigExtension,
].flat();
