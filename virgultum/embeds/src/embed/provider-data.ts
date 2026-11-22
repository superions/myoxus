// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
/** Data-only entry for Page players; importing a provider must not register its Canvas views. */
export { loomUrlRegex } from "./embed-loom-block/embed-loom-model";
export { queryEmbedLoomData } from "./embed-loom-block/utils";
export { youtubeUrlRegex } from "./embed-youtube-block/embed-youtube-model";
export { queryEmbedYoutubeData } from "./embed-youtube-block/utils";
export {
  queryEmbedGithubApiData,
  queryEmbedGithubData,
} from "./embed-github-block/utils";
export {
  formatForgeCardDate,
  parseCardUrl,
  parseGitForgeUrl,
  resolveGitForgeFamily,
  resolveGitForgeTargets,
} from "./embed-github-block/git-forge";
export { iframeSandbox, safeGetIframeSrc } from "./embed-iframe-block/utils";
