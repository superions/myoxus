import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import type { ExtensionType } from "@virgultum/store";
import { literal } from "lit/static-html.js";

export const DataViewBlockSpec: ExtensionType[] = [
  FlavourExtension("myoxus:data-view"),
  BlockViewExtension("myoxus:data-view", literal`myoxus-data-view`),
];
