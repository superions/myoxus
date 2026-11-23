import { BpmnBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";

import { BpmnClipboardController } from "./clipboard.js";
import { bpmnSlashMenuConfig } from "./slash-menu.js";

const flavour = BpmnBlockSchema.model.flavour;

export const BpmnBlockSpec: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, "myoxus-bpmn"),
  SlashMenuConfigExtension(flavour, bpmnSlashMenuConfig),
  BpmnClipboardController,
];
