// SPDX-License-Identifier: AGPL-3.0-or-later

import { EventBlockSchema } from "@virgultum/core/models";
import { BlockViewExtension, FlavourExtension } from "@virgultum/core/runtime";
import type { ExtensionType } from "@virgultum/core/store";
import { SlashMenuConfigExtension } from "@virgultum/core/slash-menu";
import { literal } from "lit/static-html.js";

import { eventSlashMenuConfig } from "./slash-menu.js";

const flavour = EventBlockSchema.model.flavour;

export const EventBlockSpec: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, literal`myoxus-event`),
  SlashMenuConfigExtension(flavour, eventSlashMenuConfig),
];
