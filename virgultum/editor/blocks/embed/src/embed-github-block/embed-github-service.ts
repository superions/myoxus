import {
  EmbedGithubBlockSchema,
  type EmbedGithubModel,
  EmbedGithubStyles,
} from "@virgultum/model";
import {
  EmbedOptionConfig,
  LinkPreviewServiceIdentifier,
} from "@virgultum/shared/services";
import { BlockService } from "@virgultum/std";

import { githubUrlRegex } from "./embed-github-model.js";
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
  urlRegex: githubUrlRegex,
  styles: EmbedGithubStyles,
  viewType: "card",
});
