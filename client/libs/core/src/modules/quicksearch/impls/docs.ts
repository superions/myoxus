import { effect, Entity, LiveData, onComplete, onStart } from "@myoxus/infra";
import { truncate } from "lodash-es";
import { catchError, EMPTY, map, of, switchMap, tap, throttleTime } from "rxjs";

import type { DocsService } from "../../doc";
import type { DocDisplayMetaService } from "../../doc-display-meta";
import type { DocsSearchService } from "../../docs-search";
import type { WorkspaceService } from "../../workspace";
import type { QuickSearchSession } from "../providers/quick-search-provider";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";

const group = {
  id: "docs",
  label: { i18nKey: "com.myoxus.cmdk.category.pages" },
  score: 20,
} satisfies QuickSearchGroup;

interface DocsPayload {
  docId: string;
  title?: string;
  blockId?: string | undefined;
  blockContent?: string | undefined;
}

export class DocsQuickSearchSession
  extends Entity
  implements QuickSearchSession<"docs", DocsPayload>
{
  readonly group = group;
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly docsSearchService: DocsSearchService,
    private readonly docsService: DocsService,
    private readonly docDisplayMetaService: DocDisplayMetaService,
  ) {
    super();
  }

  private readonly isIndexerLoading$ = this.docsSearchService.indexerState$.map(
    ({ completed }) => {
      return !completed;
    },
  );

  private readonly isQueryLoading$ = new LiveData(false);

  isCloudWorkspace = this.workspaceService.workspace.flavour !== "local";

  isLoading$ = LiveData.computed((get) => {
    return (
      (this.isCloudWorkspace ? false : get(this.isIndexerLoading$)) ||
      get(this.isQueryLoading$)
    );
  });

  error$ = new LiveData<any>(null);

  items$ = new LiveData<QuickSearchItem<"docs", DocsPayload>[]>([]);

  private lastQuery = "";

  private readonly runQuery = effect(
    throttleTime<string>(500, undefined, {
      leading: false,
      trailing: true,
    }),
    switchMap((query: string) => {
      let out;
      if (!query) {
        out = of({ items: [], useLocalLabel: false });
      } else {
        const preferMode = this.isCloudWorkspace ? "remote" : "local";
        const search$ = this.docsSearchService.search$(query, preferMode).pipe(
          map((docs) => ({
            docs,
            useLocalLabel: preferMode === "local",
          })),
        );

        out = search$.pipe(
          map(({ docs, useLocalLabel }) => {
            const items = docs.map((doc) => {
              const docRecord = this.docsService.list.doc$(doc.docId).value;
              const displayMeta = docRecord
                ? this.docDisplayMetaService.getDocDisplayMeta(docRecord)
                : undefined;
              return {
                id: "doc:" + doc.docId,
                source: "docs",
                group: {
                  id: "docs",
                  label: {
                    i18nKey: useLocalLabel
                      ? "com.myoxus.quicksearch.group.searchfor-locally"
                      : "com.myoxus.quicksearch.group.searchfor",
                    options: { query: truncate(query) },
                  },
                  score: 20,
                },
                label: {
                  title: displayMeta?.title ||
                    doc.title || {
                      i18nKey: "Untitled",
                    },
                  subTitle: doc.blockContent,
                },
                score: doc.score,
                icon: displayMeta?.icon,
                timestamp: displayMeta?.updatedDate,
                payload: doc,
              } as QuickSearchItem<"docs", DocsPayload>;
            });
            return { items, useLocalLabel };
          }),
        );
      }
      return out.pipe(
        tap(({ items }) => {
          this.items$.next(items);
          this.isQueryLoading$.next(false);
        }),
        onStart(() => {
          this.error$.next(null);
          this.items$.next([]);
          this.isQueryLoading$.next(true);
        }),
        catchError((err) => {
          this.error$.next(err instanceof Error ? err.message : err);
          this.items$.next([]);
          this.isQueryLoading$.next(false);
          return EMPTY;
        }),
        onComplete(() => {}),
      );
    }),
  );

  query = (query: string) => {
    this.lastQuery = query;
    this.runQuery(query);
  };

  retry = () => {
    this.runQuery(this.lastQuery);
  };

  // TODO(@EYHN): load more

  override dispose(): void {
    this.runQuery.unsubscribe();
  }
}
