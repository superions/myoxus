import { EmbedFigmaBlockSchema, EmbedFigmaStyles } from "@virgultum/model";
import { EmbedOptionConfig } from "@virgultum/shared/services";

import { figmaUrlRegex } from "./embed-figma-model.js";

export const EmbedFigmaBlockOptionConfig = EmbedOptionConfig({
  flavour: EmbedFigmaBlockSchema.model.flavour,
  urlRegex: figmaUrlRegex,
  styles: EmbedFigmaStyles,
  viewType: "embed",
});
