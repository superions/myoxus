import {
  type DatabaseDocumentReferenceFieldsFragment,
  DocumentGraphDirection,
  DocumentGraphTargetState,
  type DocumentLinksQuery,
  documentLinksQuery,
} from "@myoxus/graphql";
import {
  catchErrorInto,
  effect,
  Entity,
  exhaustMapWithTrailing,
  fromPromise,
  LiveData,
  onComplete,
  onStart,
  smartRetry,
} from "@myoxus/infra";
import { catchError, EMPTY, type Subscription, tap, throwError } from "rxjs";

import type { DocService, DocsService } from "../../doc";
import { isDocumentNotFoundError } from "../../doc/errors";
import type { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import type { DocsSearchService } from "../../docs-search";
import type { FeatureFlagService } from "../../feature-flag";
import type {
  DefaultServerService,
  WorkspaceServerService,
} from "../../server";
import { GraphQLService } from "../../server/services/graphql";
import type { WorkspaceService } from "../../workspace";

export interface Backlink {
  docId: string;
  blockId: string;
  title: string;
  noteBlockId?: string;
  displayMode?: string;
  parentBlockId?: string;
  parentFlavour?: string;
  markdownPreview?: string;
}

export function shouldUseRemoteBacklinkIndexer(
  batterySaveMode: boolean,
  workspaceFlavour: string,
) {
  return batterySaveMode && workspaceFlavour !== "local";
}

export class DocBacklinks extends Entity {
  constructor(
    private readonly docsSearchService: DocsSearchService,
    private readonly docService: DocService,
    private readonly docsService: DocsService,
    private readonly featureFlagService: FeatureFlagService,
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly defaultServerService: DefaultServerService,
    private readonly documentLifecycle: DocumentLifecycleStore,
  ) {
    super();
    this.lifecycleSubscription = this.documentLifecycle
      .state$(this.docService.doc.id)
      .subscribe((state) => {
        if (state !== "available") {
          this.wasTerminal = true;
          if (state === "not-found") {
            this.reloadAfterCreate = false;
          }
          this.initialLoadRequested = false;
          this.backlinks$.value = [];
          this.databaseReferences$.value = [];
          this.isLoading$.value = false;
          this.isLoaded$.value = false;
        } else if (this.wasTerminal) {
          this.wasTerminal = false;
          if (this.reloadAfterCreate) {
            this.reloadAfterCreate = false;
            this.revalidateFromCloud();
          } else {
            this.requestInitialLoad();
          }
        }
      });
  }

  backlinks$ = new LiveData<Backlink[]>([]);
  databaseReferences$ = new LiveData<DatabaseDocumentReferenceFieldsFragment[]>(
    [],
  );

  isLoading$ = new LiveData<boolean>(false);
  isLoaded$ = new LiveData<boolean>(false);
  error$ = new LiveData<any>(undefined);
  private lifecycleSubscription?: Subscription;
  private wasTerminal = false;
  private reloadAfterCreate = false;
  private activeLoadConsumers = 0;
  private initialLoadRequested = false;

  /**
   * Register one visible consumer of this document's backlinks. Initial
   * acquisition is shared for the entity lifetime; explicit invalidation keeps
   * using `revalidateFromCloud` and may intentionally queue a trailing read.
   */
  acquireLoadDemand = () => {
    this.activeLoadConsumers += 1;
    this.requestInitialLoad();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeLoadConsumers = Math.max(0, this.activeLoadConsumers - 1);
    };
  };

  private requestInitialLoad() {
    if (
      this.initialLoadRequested ||
      this.activeLoadConsumers === 0 ||
      !this.documentLifecycle.isAvailable(this.docService.doc.id)
    ) {
      return;
    }
    this.initialLoadRequested = true;
    this.loadFromCloud();
  }

  revalidateFromCloud = () => {
    const state = this.documentLifecycle.state(this.docService.doc.id);
    if (state === "creating") {
      this.reloadAfterCreate = true;
      return;
    }
    if (state === "available") {
      this.loadFromCloud();
    }
  };

  private loadFromCloud = effect(
    exhaustMapWithTrailing(() =>
      fromPromise(async (attemptSignal) => {
        if (this.shouldUseServerDocumentGraph()) {
          return this.loadServerBacklinks(attemptSignal);
        }
        const searchFromCloud = shouldUseRemoteBacklinkIndexer(
          this.featureFlagService.flags.enable_battery_save_mode.value,
          this.workspaceService.workspace.flavour,
        );
        const { buckets } = await this.docsSearchService.indexer.aggregate(
          "block",
          {
            type: "boolean",
            occur: "must",
            queries: [
              {
                type: "match",
                field: "refDocId",
                match: this.docService.doc.id,
              },
            ],
          },
          "docId",
          {
            hits: {
              fields: [
                "docId",
                "blockId",
                "parentBlockId",
                "parentFlavour",
                "additional",
                "markdownPreview",
              ],
              pagination: {
                limit: BUILD_CONFIG.isElectron ? 100 : 5, // the max number of backlinks to show for each doc
              },
            },
            pagination: {
              limit: 100,
            },
            prefer: searchFromCloud ? "remote" : "local",
          },
        );
        return buckets.flatMap((bucket) => {
          const title =
            this.docsService.list.doc$(bucket.key).value?.title$.value ?? "";

          if (bucket.key === this.docService.doc.id) {
            // Ignore if it is a link to the current document.
            return [];
          }

          return bucket.hits.nodes.map((node) => {
            const blockId = node.fields.blockId ?? "";
            const markdownPreview = node.fields.markdownPreview ?? "";
            const additional =
              typeof node.fields.additional === "string"
                ? node.fields.additional
                : node.fields.additional[0];

            const additionalData: {
              displayMode?: string;
              noteBlockId?: string;
            } = JSON.parse(additional || "{}");

            const displayMode = additionalData.displayMode ?? "";
            const noteBlockId = additionalData.noteBlockId ?? "";
            const parentBlockId =
              typeof node.fields.parentBlockId === "string"
                ? node.fields.parentBlockId
                : node.fields.parentBlockId[0];
            const parentFlavour =
              typeof node.fields.parentFlavour === "string"
                ? node.fields.parentFlavour
                : node.fields.parentFlavour[0];

            return {
              docId: bucket.key,
              blockId: typeof blockId === "string" ? blockId : blockId[0],
              title: title,
              markdownPreview:
                typeof markdownPreview === "string"
                  ? markdownPreview
                  : markdownPreview[0],
              displayMode:
                typeof displayMode === "string" ? displayMode : displayMode[0],
              noteBlockId:
                typeof noteBlockId === "string" ? noteBlockId : noteBlockId[0],
              parentBlockId:
                typeof parentBlockId === "string"
                  ? parentBlockId
                  : parentBlockId[0],
              parentFlavour:
                typeof parentFlavour === "string"
                  ? parentFlavour
                  : parentFlavour[0],
            };
          });
        });
      }).pipe(
        catchError((error) => this.handleRequestError(error)),
        smartRetry({ count: 0 }),
        tap((backlinks) => {
          this.backlinks$.value = backlinks;
          this.isLoaded$.value = true;
        }),
        catchErrorInto(this.error$),
        onStart(() => {
          this.isLoading$.value = true;
        }),
        onComplete(() => {
          this.isLoading$.value = false;
        }),
      ),
    ),
  );

  override dispose(): void {
    this.loadFromCloud.unsubscribe();
    this.lifecycleSubscription?.unsubscribe();
    super.dispose();
  }

  private handleRequestError(error: unknown) {
    if (isDocumentNotFoundError(error)) {
      this.documentLifecycle.markNotFound(this.docService.doc.id);
    }
    if (!this.documentLifecycle.isAvailable(this.docService.doc.id)) {
      this.backlinks$.value = [];
      this.databaseReferences$.value = [];
      return EMPTY;
    }
    return throwError(() => error);
  }

  private shouldUseServerDocumentGraph() {
    return (
      !BUILD_CONFIG.isElectron &&
      this.workspaceService.workspace.flavour !== "local"
    );
  }

  private get serverService() {
    return (
      this.workspaceServerService.server || this.defaultServerService.server
    );
  }

  private get graphqlService() {
    // Doc link entities are doc-scoped, while GraphQLService is server-scoped.
    // Resolve it through the bound workspace server to keep Browser Web linked
    // to the authoritative server graph without breaking local/Electron docs.
    return this.serverService?.scope.get(GraphQLService);
  }

  private async loadServerBacklinks(
    attemptSignal: AbortSignal,
  ): Promise<Backlink[]> {
    const graphqlService = this.graphqlService;
    if (!graphqlService) {
      throw new Error("GraphQL service not found");
    }
    const response = (await graphqlService.gql({
      query: documentLinksQuery,
      variables: {
        workspaceId: this.workspaceService.workspace.id,
        input: {
          docId: this.docService.doc.id,
          direction: DocumentGraphDirection.Incoming,
          first: 100,
          includeOccurrences: true,
        },
      },
      context: {
        signal: this.documentLifecycle.requestSignal(
          this.docService.doc.id,
          attemptSignal,
        ),
      },
    } as never)) as DocumentLinksQuery;
    const model = response.workspace?.documentLinks;
    if (!model) {
      this.databaseReferences$.value = [];
      return [];
    }
    this.databaseReferences$.value = model.databaseReferences;
    const titles = new Map(
      model.nodes.map((node) => [node.rawDocId, node.title ?? ""] as const),
    );
    return model.edges.flatMap((edge) => {
      if (edge.targetState === DocumentGraphTargetState.Redacted) {
        return [];
      }
      const title = titles.get(edge.sourceDocId) ?? "";
      return edge.occurrences.map((occurrence) => {
        const params = occurrence.paramsJson ?? {};
        return {
          docId: edge.sourceDocId,
          blockId: occurrence.sourceBlockId,
          title,
          markdownPreview:
            occurrence.markdownPreview ?? edge.firstOccurrencePreview ?? "",
          displayMode: stringParam(params, "mode"),
          parentBlockId: occurrence.sourceParentBlockId ?? undefined,
          parentFlavour: occurrence.sourceParentFlavour ?? undefined,
        };
      });
    });
  }
}

function stringParam(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}
