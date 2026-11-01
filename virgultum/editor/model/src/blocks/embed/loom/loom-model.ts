import { BlockModel } from "@virgultum/store";

import { defineEmbedModel, type EmbedCardStyle } from "../../../utils/index.js";

export type EmbedLoomBlockUrlData = {
  videoId: string | null;
  image: string | null;
  title: string | null;
  description: string | null;
};

export const EmbedLoomStyles = ["video"] as const satisfies EmbedCardStyle[];

export type EmbedLoomBlockProps = {
  style: (typeof EmbedLoomStyles)[number];
  url: string;
  caption: string | null;
} & EmbedLoomBlockUrlData;

export class EmbedLoomModel extends defineEmbedModel<EmbedLoomBlockProps>(
  BlockModel,
) {}
