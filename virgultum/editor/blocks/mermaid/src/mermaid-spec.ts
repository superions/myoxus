import { MermaidBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

import { MermaidClipboardController } from "./clipboard.js";
import { MermaidEdgelessOwnerGfxSync } from "./presentation/edgeless-owner-gfx-sync.js";
import { MermaidEmbeddedChildVisibility } from "./presentation/embedded-child-visibility.js";
import {
  MermaidEdgelessBlockInteraction,
  MermaidEdgelessSubgraphInteraction,
} from "./presentation/mermaid-edgeless-block.js";
import { mermaidSlashMenuConfig } from "./slash-menu.js";

const flavour = MermaidBlockSchema.model.flavour;

export const MermaidBlockSpec: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, (model) =>
    model.parent?.flavour === "myoxus:surface"
      ? literal`myoxus-edgeless-mermaid`
      : literal`myoxus-mermaid`,
  ),
  SlashMenuConfigExtension(flavour, mermaidSlashMenuConfig),
  MermaidClipboardController,
];

export const MermaidEdgelessBlockSpec: ExtensionType[] = [
  MermaidEmbeddedChildVisibility,
  MermaidEdgelessBlockInteraction,
  MermaidEdgelessSubgraphInteraction,
  MermaidEdgelessOwnerGfxSync,
];
