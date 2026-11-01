import {
  EmbedLoomBlockSchema,
  type EmbedLoomModel,
  EmbedLoomStyles,
} from "@virgultum/model";
import { EmbedOptionConfig } from "@virgultum/shared/services";
import { BlockService } from "@virgultum/std";

import { loomUrlRegex } from "./embed-loom-model.js";
import { queryEmbedLoomData } from "./utils.js";

export class EmbedLoomBlockService extends BlockService {
  static override readonly flavour = EmbedLoomBlockSchema.model.flavour;

  queryUrlData = (embedLoomModel: EmbedLoomModel, signal?: AbortSignal) => {
    return queryEmbedLoomData(embedLoomModel, signal);
  };
}

export const EmbedLoomBlockOptionConfig = EmbedOptionConfig({
  flavour: EmbedLoomBlockSchema.model.flavour,
  urlRegex: loomUrlRegex,
  styles: EmbedLoomStyles,
  viewType: "embed",
});
