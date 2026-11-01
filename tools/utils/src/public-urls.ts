// SPDX-License-Identifier: AGPL-3.0-or-later

const repository = "https://github.com/superions/myoxus";
const repositoryFile = (path: string) => `${repository}/blob/main/${path}`;

/** Public destinations owned by the Myoxus project. */
export const PUBLIC_PROJECT_URLS = Object.freeze({
  aiOperations: repositoryFile("docs/ops/integrations/ai.md"),
  documentation: repositoryFile("docs/README.md"),
  downloads: repositoryFile("docs/user/downloads.md"),
  handbook: repositoryFile("docs/user/README.md"),
  issues: `${repository}/issues`,
  license: repositoryFile("LICENSE"),
  operatorGuide: repositoryFile("docs/ops/README.md"),
  pullRequests: `${repository}/pulls`,
  releases: `${repository}/releases`,
  repository,
  security: repositoryFile("SECURITY.md"),
  upgradeGuide: `${repositoryFile("docs/ops/deployment/docker.md")}#upgrade-procedure`,
});
