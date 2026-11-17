import {
  EmbedGithubBlockSchema,
  type EmbedGithubModel,
  EmbedGithubStyles,
} from "@virgultum/core/models";
import {
  EmbedOptionConfig,
  LinkPreviewServiceIdentifier,
} from "@virgultum/core/services";
import { BlockService } from "@virgultum/core/runtime";

import { gitForgeUrlRegex } from "./embed-github-model.js";
import { queryEmbedGithubApiData, queryEmbedGithubData } from "./utils.js";

export class EmbedGithubBlockService extends BlockService {
  static override readonly flavour = EmbedGithubBlockSchema.model.flavour;

  queryApiData = (embedGithubModel: EmbedGithubModel, signal?: AbortSignal) => {
    return queryEmbedGithubApiData(embedGithubModel, signal);
  };

  queryUrlData = (embedGithubModel: EmbedGithubModel, signal?: AbortSignal) => {
    return queryEmbedGithubData(
      embedGithubModel,
      this.std.get(LinkPreviewServiceIdentifier),
      signal,
    );
  };
}

export const EmbedGithubBlockOptionConfig = EmbedOptionConfig({
  flavour: EmbedGithubBlockSchema.model.flavour,
  urlRegex: gitForgeUrlRegex,
  styles: EmbedGithubStyles,
  viewType: "card",
});
