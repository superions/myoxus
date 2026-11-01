import { BpmnBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

import { BpmnClipboardController } from "./clipboard.js";
import { bpmnSlashMenuConfig } from "./slash-menu.js";

const flavour = BpmnBlockSchema.model.flavour;

export const BpmnBlockSpec: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, literal`myoxus-bpmn`),
  SlashMenuConfigExtension(flavour, bpmnSlashMenuConfig),
  BpmnClipboardController,
];
