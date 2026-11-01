import type { ParagraphBlockModel } from "@virgultum/model";
import { ConfigExtensionFactory } from "@virgultum/std";

export interface ParagraphBlockConfig {
  getPlaceholder: (model: ParagraphBlockModel) => string;
}

export const ParagraphBlockConfigExtension =
  ConfigExtensionFactory<ParagraphBlockConfig>("myoxus:paragraph");
