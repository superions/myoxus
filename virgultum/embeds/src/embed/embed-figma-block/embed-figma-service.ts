import {
  EmbedFigmaBlockSchema,
  EmbedFigmaStyles,
} from "@virgultum/core/models";
import { EmbedOptionConfig } from "@virgultum/core/services";

import { figmaUrlRegex } from "./embed-figma-model.js";

export const EmbedFigmaBlockOptionConfig = EmbedOptionConfig({
  flavour: EmbedFigmaBlockSchema.model.flavour,
  urlRegex: figmaUrlRegex,
  styles: EmbedFigmaStyles,
  viewType: "embed",
});
