import { BlockModel } from "@virgultum/store";

import { defineEmbedModel, type EmbedCardStyle } from "../../../utils/index.js";

export const EmbedHtmlStyles = ["html"] as const satisfies EmbedCardStyle[];

export type EmbedHtmlBlockProps = {
  style: (typeof EmbedHtmlStyles)[number];
  caption: string | null;
  html?: string;
  design?: string;
};

export class EmbedHtmlModel extends defineEmbedModel<EmbedHtmlBlockProps>(
  BlockModel,
) {}
