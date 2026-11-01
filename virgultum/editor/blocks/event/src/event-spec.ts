// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBlockSchema } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

import { eventSlashMenuConfig } from "./slash-menu.js";

const flavour = EventBlockSchema.model.flavour;

export const EventBlockSpec: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, literal`myoxus-event`),
  SlashMenuConfigExtension(flavour, eventSlashMenuConfig),
];
