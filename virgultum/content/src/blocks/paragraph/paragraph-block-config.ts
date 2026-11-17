import type { ParagraphBlockModel } from "@virgultum/core/models";
import { ConfigExtensionFactory } from "@virgultum/core/runtime";

export interface ParagraphBlockConfig {
  getPlaceholder: (model: ParagraphBlockModel) => string;
}

export const ParagraphBlockConfigExtension =
  ConfigExtensionFactory<ParagraphBlockConfig>("myoxus:paragraph");
