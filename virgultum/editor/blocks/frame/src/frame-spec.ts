import { FrameBlockSchema } from "@virgultum/model";
import { BlockViewExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { literal } from "lit/static-html.js";

import { FrameBlockInteraction } from "./frame-block";
import { EdgelessFrameManager, FrameOverlay } from "./frame-manager";

const flavour = FrameBlockSchema.model.flavour;

export const FrameBlockSpec: ExtensionType[] = [
  BlockViewExtension(flavour, literal`myoxus-frame`),
  FrameOverlay,
  EdgelessFrameManager,
  FrameBlockInteraction,
];
