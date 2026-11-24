import { FrameBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";

import { FrameBlockInteraction } from "./frame-block";
import { EdgelessFrameManager, FrameOverlay } from "./frame-manager";

const flavour = FrameBlockSchema.model.flavour;

export const FrameBlockSpec: ExtensionType[] = [
  BlockViewExtension(flavour, "myoxus-frame"),
  FrameOverlay,
  EdgelessFrameManager,
  FrameBlockInteraction,
];
