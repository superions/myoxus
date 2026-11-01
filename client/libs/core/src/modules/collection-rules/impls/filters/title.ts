import type { DocsService } from "@myoxus/core/modules/doc";
import type { WorkspaceService } from "@myoxus/core/modules/workspace";
import type { DocsSearchService } from "@myoxus/core/modules/docs-search";
import { Service } from "@myoxus/infra";
import { GeneralTokenizer } from "@myoxus/storage/tokenizer";
import { combineLatest, defer, map, type Observable } from "rxjs";

import type { FilterProvider } from "../../provider";
import type { FilterParams } from "../../types";

/**
 * Preserve title-index OR/prefix matching without its posting limit or ranking.
 * Prepare once per subscription; each call segments one catalogue title once.
 */
export function createTitleMatcher(query: string): (title: string) => boolean {
  const tokenizer = new GeneralTokenizer();
  const queryTerms = tokenizer.tokenize(query).map(({ term }) => term);
  return (title) => {
    if (queryTerms.length === 0) return false;
    const tokens = tokenizer.tokenize(title);
    return queryTerms.some((queryTerm) =>
      tokens.some(({ term }) => term.startsWith(queryTerm)),
    );
  };
}

export class TitleFilterProvider extends Service implements FilterProvider {
  constructor(
    private readonly docsSearchService: DocsSearchService,
    private readonly docsService: DocsService,
    private readonly workspaceService: WorkspaceService,
  ) {
    super();
  }

  filter$(params: FilterParams): Observable<Set<string>> {
    const method = params.method as "match";

    if (method === "match") {
      // Native apps (including Electron cloud workspaces) retain local search.
      if (
        BUILD_CONFIG.isWeb &&
        !BUILD_CONFIG.isElectron &&
        !BUILD_CONFIG.isIOS &&
        !BUILD_CONFIG.isAndroid &&
        this.workspaceService.workspace.flavour !== "local"
      ) {
        return defer(() => {
          const matches = createTitleMatcher(params.value ?? "");
          return combineLatest([
            this.docsService.allDocTitle$(),
            this.docsService.allNonTrashDocIds$(),
          ]).pipe(
            map(([titles, activeIds]) => {
              // Root titles include Trash. Keep the indexer's active-only
              // contract independently of the Collection's extra filters.
              const active = new Set(activeIds);
              const matched = new Set<string>();
              for (const { id, title } of titles) {
                if (active.has(id) && matches(title)) matched.add(id);
              }
              return matched;
            }),
          );
        });
      }
      return this.docsSearchService
        .searchTitle$(params.value ?? "")
        .pipe(map((list) => new Set(list)));
    }

    throw new Error(`Unsupported method: ${params.method}`);
  }
}
