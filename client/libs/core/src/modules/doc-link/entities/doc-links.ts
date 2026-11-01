import {
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
import {
  catchError,
  EMPTY,
  map as rxMap,
  type Subscription,
  tap,
  throwError,
} from "rxjs";

import type { DocService } from "../../doc";
import { isDocumentNotFoundError } from "../../doc/errors";
import type { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import type { DocsSearchService } from "../../docs-search";
import type {
  DefaultServerService,
  WorkspaceServerService,
} from "../../server";
import { GraphQLService } from "../../server/services/graphql";
import type { WorkspaceService } from "../../workspace";

export interface Link {
  docId?: string;
  workspaceId?: string;
  rawDocId: string;
  title: string;
  targetState: DocumentGraphTargetState;
  params?: URLSearchParams;
}

export class DocLinks extends Entity {
  constructor(
    private readonly docsSearchService: DocsSearchService,
    private readonly docService: DocService,
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly defaultServerService: DefaultServerService,
    private readonly documentLifecycle: DocumentLifecycleStore,
  ) {
    super();
    this.links$ = this.shouldUseServerDocumentGraph()
      ? new LiveData<Link[]>([])
      : LiveData.from<Link[]>(
          this.docsSearchService.watchRefsFrom(this.docService.doc.id).pipe(
            rxMap((links) =>
              links.map((link) => ({
                ...link,
                rawDocId: link.docId,
                targetState: DocumentGraphTargetState.Available,
              })),
            ),
          ),
          [],
        );
    if (!this.shouldUseServerDocumentGraph()) {
      this.initialLoadRequested = true;
      this.isLoaded$.value = true;
    }
    this.lifecycleSubscription = this.documentLifecycle
      .state$(this.docService.doc.id)
      .subscribe((state) => {
        if (state !== "available") {
          this.wasTerminal = true;
          if (state === "not-found") {
            this.reloadAfterCreate = false;
          }
          this.initialLoadRequested = false;
          this.links$.value = [];
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

  links$: LiveData<Link[]>;

  isLoading$ = new LiveData<boolean>(false);
  isLoaded$ = new LiveData<boolean>(false);
  error$ = new LiveData<any>(undefined);
  private lifecycleSubscription?: Subscription;
  private wasTerminal = false;
  private reloadAfterCreate = false;
  private activeLoadConsumers = 0;
  private initialLoadRequested = false;

  /**
   * Register one visible consumer of this document's outgoing links. Initial
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
    if (!this.shouldUseServerDocumentGraph()) {
      this.isLoaded$.value = true;
      return;
    }
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
        if (!this.shouldUseServerDocumentGraph()) {
          return this.links$.value;
        }
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
              direction: DocumentGraphDirection.Outgoing,
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
          return [];
        }
        const labels = new Map(
          model.nodes.map((node) => [
            JSON.stringify([node.workspaceId, node.rawDocId]),
            node.title?.trim() || node.rawDocId,
          ]),
        );
        return model.edges.map((edge): Link => {
          const title = edge.targetDocId
            ? (model.nodes.find(
                (node) =>
                  node.docId === edge.targetDocId &&
                  node.workspaceId === edge.targetWorkspaceId,
              )?.title ?? edge.rawTargetDocId)
            : (labels.get(
                JSON.stringify([edge.targetWorkspaceId, edge.rawTargetDocId]),
              ) ?? edge.rawTargetDocId);
          return {
            docId: edge.targetDocId ?? undefined,
            workspaceId: edge.targetWorkspaceId ?? undefined,
            rawDocId: edge.rawTargetDocId,
            title,
            targetState: edge.targetState,
            params: urlSearchParamsFromJson(edge.occurrences[0]?.paramsJson),
          };
        });
      }).pipe(
        catchError((error) => this.handleRequestError(error)),
        smartRetry({ count: 0 }),
        tap((links) => {
          if (this.shouldUseServerDocumentGraph()) {
            this.links$.value = links;
          }
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
      this.links$.value = [];
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
    // GraphQLService is owned by the server scope. Resolve it lazily from the
    // bound workspace server so the doc-scoped entity can still be constructed
    // for local/Electron workspaces that use the search-index fallback.
    return this.serverService?.scope.get(GraphQLService);
  }
}

function urlSearchParamsFromJson(value: unknown): URLSearchParams | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const params = new URLSearchParams();
  for (const [key, candidate] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof candidate === "string") {
      params.set(key, candidate);
    } else if (Array.isArray(candidate)) {
      const values = candidate.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (values.length > 0) {
        params.set(key, values.join(","));
      }
    }
  }
  return params.size > 0 ? params : undefined;
}
