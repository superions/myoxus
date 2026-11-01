import {
  type TemplateSuggestionInput,
  type TemplateSuggestionItemFieldsFragment,
  templateSuggestionsQuery,
  assistantDocumentSourceQuery,
  type AssistantDocumentSourceInput,
  TemplateSuggestionSurface,
} from "@myoxus/graphql";
import { LiveData, Service } from "@myoxus/infra";

import type { DocRecord } from "../../doc";
import {
  DefaultServerService,
  GraphQLService,
  WorkspaceServerService,
} from "../../server";
import { WorkspaceService } from "../../workspace";
import { TemplateDocList } from "../entities/list";
import { TemplateDocSetting } from "../entities/setting";
import {
  type ResolvedTemplateSourceMetadata,
  nativeSourceMetadata,
  customSourceMetadata,
  isBuildingBlockCategory,
} from "./source-metadata";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "./template-instantiation-error";
import type { BuiltinTemplateReconcilerService } from "./builtin-reconciler";

/** Unknown/custom categories pass exclusion filters and fail inclusion filters. */
export type TemplateCategoryFilter =
  { include: string[] } | { exclude: string[] };

export { TemplateSuggestionSurface };

export interface TemplateSuggestionMenuItem {
  templateId: string;
  templateDocId: string | null;
  title: string;
  description: string | null;
  origin: TemplateSourceOrigin;
  updatedAt: number | null;
  category: string | null;
  tags: readonly string[];
  score: number;
  reasons: string[];
  instanceState: string | null;
  available: boolean;
  protectedSource: boolean;
  /** Materialized Registry revision, not the latest available publication. */
  sourceRevisionId?: string | null;
}

export type TemplateSourceOrigin =
  "builtin" | "imported" | "custom" | "unknown";

export function templateSuggestionSourceKey(
  item: Pick<TemplateSuggestionMenuItem, "origin" | "templateId">,
) {
  return `${item.origin === "builtin" || item.origin === "imported" ? "registry" : "document"}:${item.templateId}`;
}

export interface TemplateSuggestionMenuState {
  status: "idle" | "loading" | "ready" | "error";
  surface: TemplateSuggestionSurface | null;
  items: TemplateSuggestionMenuItem[];
  emptyDocumentAllowed: boolean;
  reconcileRequired: boolean;
  stale: boolean;
  hasNextPage: boolean;
  endCursor: string | null;
  error: Error | null;
}

export interface LoadTemplateSuggestionsOptions extends Omit<
  TemplateSuggestionInput,
  "clientVersion" | "locale"
> {
  locale?: string;
  categoryFilter?: TemplateCategoryFilter;
}

const DEFAULT_TEMPLATE_SUGGESTION_LIMIT = 8;
export const TEMPLATE_SUGGESTION_CLIENT_VERSION = 1;
const MAX_TEMPLATE_SUGGESTION_PAGES = 100;

const emptySuggestionState = (): TemplateSuggestionMenuState => ({
  status: "idle",
  surface: null,
  items: [],
  emptyDocumentAllowed: true,
  reconcileRequired: false,
  stale: false,
  hasNextPage: false,
  endCursor: null,
  error: null,
});

type LibraryProjection = {
  inventory: TemplateSuggestionMenuState;
  metadata: Record<string, ResolvedTemplateSourceMetadata>;
  key: string | null;
};

export class TemplateDocService extends Service {
  public readonly list = this.framework.createEntity(TemplateDocList);
  public readonly setting = this.framework.createEntity(TemplateDocSetting);
  public readonly templateSuggestions$ =
    new LiveData<TemplateSuggestionMenuState>(emptySuggestionState());
  private suggestionGeneration = 0;
  private activeSuggestionRequest:
    { key: string; promise: Promise<TemplateSuggestionMenuState> } | undefined;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly defaultServerService: DefaultServerService,
    private readonly builtinReconciler: BuiltinTemplateReconcilerService,
  ) {
    super();
  }

  // Inventory and its classifications are one publication. Contextual pickers
  // retain their independent transient result and cannot replace Library pages.
  private readonly sourceMetadata$ = new LiveData<LibraryProjection>({
    inventory: emptySuggestionState(),
    metadata: {},
    key: null,
  });
  private metadataRequest:
    { key: string; promise: Promise<TemplateSuggestionMenuState> } | undefined;
  private metadataGeneration = 0;
  private metadataEpoch = 0;

  /** Observe the current Library page without fetching. A changed query hides
   * the old page immediately, before the route's request effect runs.
   */
  public templateLibraryInventory$(options?: LoadTemplateSuggestionsOptions) {
    const key = options
      ? suggestionRequestKey({ ...options, after: undefined })
      : null;
    return this.sourceMetadata$.map((projection) =>
      key && projection.key !== key
        ? emptySuggestionState()
        : projection.inventory,
    );
  }

  public getTemplateDocs(
    filter?: TemplateCategoryFilter,
    surface?: TemplateSuggestionSurface,
  ): DocRecord[] {
    if (
      this.workspaceService.workspace.flavour === "local" &&
      this.setting.loading$.value
    )
      return [];
    // Native isTemplate/templateState metadata identifies cloud sources even
    // when their Library page has not been loaded.
    const metadata = this.resolvedSourceMetadata();
    const docs = this.list
      .getTemplateDocs()
      .filter(
        (doc) =>
          metadata[doc.id]?.purpose !== "guide" &&
          (!doc.templateAttribution$?.value?.templateId ||
            metadata[doc.id]?.source !== "custom"),
      );
    return applyCategoryFilter(docs, metadata, filter, surface);
  }

  /** Registry and native-local classifications share one read-only projection. */
  public templateSourceMetadata$() {
    return LiveData.computed((get) => ({
      ...Object.fromEntries(
        get(this.list.templateDocs$).map((doc) => [
          doc.id,
          customSourceMetadata(doc.id, get(doc.templateClassification$)),
        ]),
      ),
      ...(this.workspaceService.workspace.flavour === "local"
        ? this.localSourceMetadata(
            get(this.setting.builtinTemplateInstanceDocIds$) ?? {},
          )
        : this.cloudSourceMetadata(
            get(this.sourceMetadata$).metadata,
            get(this.builtinReconciler.bindings$),
          )),
    }));
  }

  public templateDocs$(
    filter?: TemplateCategoryFilter,
    surface?: TemplateSuggestionSurface,
  ) {
    const metadata$ = this.templateSourceMetadata$();
    return LiveData.computed((get) => {
      if (
        this.workspaceService.workspace.flavour === "local" &&
        get(this.setting.loading$)
      )
        return [];
      const metadata = get(metadata$);
      const docs = get(this.list.templateDocs$).filter(
        (doc) =>
          metadata[doc.id]?.purpose !== "guide" &&
          (!get(doc.templateAttribution$)?.templateId ||
            metadata[doc.id]?.source !== "custom"),
      );
      return applyCategoryFilter(docs, metadata, filter, surface);
    });
  }

  /** Re-read cloud authority before applying a captured document source.
   * Local settings are bindings only; their semantics come from file manifests.
   */
  public async resolveSourceMetadataForDoc(
    docId: string,
    signal?: AbortSignal,
  ) {
    if (this.workspaceService.workspace.flavour === "local") {
      // File semantics depend on the persisted slug binding, never on a cold
      // empty settings projection that would mistake a bundle for a custom doc.
      await this.setting.loading$.waitFor((loading) => !loading, signal);
    } else {
      const wait = <T>(pending: Promise<T>) =>
        signal ? waitForTemplateOperation(pending, signal) : pending;
      const epoch = this.metadataEpoch;
      const source = await wait(this.lookupTemplateSource(docId, "en"));
      if (!source?.available || source.templateDocId !== docId)
        throw new TemplateInstantiationError("source-unavailable");
      const metadata = resolveRegistrySourceMetadata(source);
      if (!metadata) throw new TemplateInstantiationError("source-unavailable");
      // Keep a newer contextual policy observed while this exact read waited.
      return epoch === this.metadataEpoch
        ? metadata
        : (this.sourceMetadata$.value.metadata[docId] ?? metadata);
    }
    const metadata = this.resolvedSourceMetadata()[docId];
    if (metadata && metadata.source !== "custom") return metadata;
    return customSourceMetadata(
      docId,
      await this.list.docsService.readTemplateClassification(docId, signal),
    );
  }

  public async assertDocumentTemplateSource(
    docId: string,
    signal?: AbortSignal,
  ) {
    const metadata = await this.resolveSourceMetadataForDoc(docId, signal);
    if (isBuildingBlockCategory(metadata?.category))
      throw new TemplateInstantiationError("building-block-source");
    return metadata;
  }

  public async assertCustomClassificationChange(
    docId: string,
    category: string | null,
  ) {
    const metadata = await this.resolveSourceMetadataForDoc(docId);
    if (metadata.source !== "custom")
      throw new TemplateInstantiationError("managed-source");
    if (!isBuildingBlockCategory(category)) return;

    // Userdata loads independently of source metadata. Inspect the persisted
    // selection even when the page-template switch is currently disabled.
    await this.setting.loading$.waitFor((loading) => !loading);
    if (
      this.setting.pageTemplateDocId$.value === docId ||
      this.setting.journalTemplateDocId$.value === docId
    )
      throw new TemplateInstantiationError("default-in-use");
  }

  private localSourceMetadata(bindings: Record<string, string>) {
    const result: Record<string, ResolvedTemplateSourceMetadata> = {};
    for (const [slug, docId] of Object.entries(bindings)) {
      const metadata = nativeSourceMetadata(slug);
      if (metadata) result[docId] = metadata;
    }
    return result;
  }

  private resolvedSourceMetadata() {
    const custom = Object.fromEntries(
      this.list
        .getTemplateDocs()
        .map((doc) => [
          doc.id,
          customSourceMetadata(doc.id, doc.templateClassification$?.value),
        ]),
    );
    const registry =
      this.workspaceService.workspace.flavour === "local"
        ? this.localSourceMetadata(
            this.setting.builtinTemplateInstanceDocIds$.value ?? {},
          )
        : this.cloudSourceMetadata(
            this.sourceMetadata$.value.metadata,
            this.builtinReconciler.bindings$.value,
          );
    return { ...custom, ...registry };
  }

  private cloudSourceMetadata(
    bundles: Record<string, ResolvedTemplateSourceMetadata>,
    bindings: BuiltinTemplateReconcilerService["bindings$"]["value"],
  ) {
    // These are read-only source=builtin Registry bindings, not local settings.
    // Retain their existing descriptors until the system identities migrate.
    const legacy: Record<string, ResolvedTemplateSourceMetadata> = {};
    for (const binding of Object.values(bindings)) {
      if (binding.metadata) legacy[binding.docId] = binding.metadata;
    }
    return { ...legacy, ...bundles };
  }

  private loadLibraryInventory(
    options: LoadTemplateSuggestionsOptions,
    force = false,
  ): Promise<TemplateSuggestionMenuState> {
    const key = suggestionRequestKey({ ...options, after: undefined });
    const flightKey = JSON.stringify([key, options.after]);
    if (this.metadataRequest?.key === flightKey)
      return this.metadataRequest.promise;
    const current = this.sourceMetadata$.value;
    if (
      !force &&
      !options.after &&
      current.key === key &&
      current.inventory.status === "ready"
    )
      return Promise.resolve(current.inventory);
    const generation = ++this.metadataGeneration;
    const epoch = this.metadataEpoch;
    const append = Boolean(options.after && current.key === key);
    const inventory =
      current.key === key ? current.inventory : emptySuggestionState();
    this.sourceMetadata$.setValue({
      ...current,
      key,
      inventory: {
        ...inventory,
        surface: TemplateSuggestionSurface.Library,
        status: "loading",
        error: null,
      },
    });
    const promise = (async () => {
      try {
        const graphqlService = this.graphqlService;
        if (!graphqlService)
          throw new Error("Template Registry is unavailable");
        const response = await graphqlService.gql({
          query: templateSuggestionsQuery,
          variables: {
            workspaceId: this.workspaceService.workspace.id,
            input: {
              surface: TemplateSuggestionSurface.Library,
              first: 200,
              after: append ? options.after : undefined,
              library: options.library,
              locale: options.locale ?? "en",
              clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
            },
          },
        });
        if (generation !== this.metadataGeneration)
          return this.sourceMetadata$.value.inventory;
        const result = response.workspace?.templateSuggestions;
        if (!result)
          throw new Error("Template Registry projection is unavailable");
        if (
          result.hasNextPage &&
          (!result.endCursor || result.endCursor === options.after)
        )
          throw new Error("Template Library continuation did not advance");
        const state = mapTemplateSuggestionResult(
          TemplateSuggestionSurface.Library,
          result,
        );
        if (append)
          state.items = [
            ...new Map(
              [...inventory.items, ...state.items].map((item) => [
                templateSuggestionSourceKey(item),
                item,
              ]),
            ).values(),
          ];
        let metadata = { ...this.sourceMetadata$.value.metadata };
        for (const item of result.items) {
          const resolved = resolveRegistrySourceMetadata(item);
          if (item.templateDocId && resolved)
            metadata[item.templateDocId] = resolved;
        }
        // An overlapping contextual lookup can carry a newer revision policy.
        if (epoch !== this.metadataEpoch)
          metadata = { ...metadata, ...this.sourceMetadata$.value.metadata };
        this.sourceMetadata$.setValue({
          key,
          inventory: state,
          metadata,
        });
        return state;
      } catch (cause) {
        if (generation !== this.metadataGeneration)
          return this.sourceMetadata$.value.inventory;
        const state: TemplateSuggestionMenuState = {
          ...inventory,
          surface: TemplateSuggestionSurface.Library,
          status: "error",
          error: cause instanceof Error ? cause : new Error(String(cause)),
        };
        this.sourceMetadata$.setValue({
          ...this.sourceMetadata$.value,
          inventory: state,
        });
        return state;
      }
    })().finally(() => {
      if (this.metadataRequest?.promise === promise)
        this.metadataRequest = undefined;
    });
    this.metadataRequest = { key: flightKey, promise };
    return promise;
  }

  /** Library reads share one in-flight page and append only an explicit cursor.
   * `force` refreshes a ready page but still joins an identical in-flight read.
   */
  public loadTemplateSuggestions(
    options: LoadTemplateSuggestionsOptions,
    force = false,
  ): Promise<TemplateSuggestionMenuState> {
    if (
      options.surface === TemplateSuggestionSurface.Library &&
      this.workspaceService.workspace.flavour !== "local"
    )
      return this.loadLibraryInventory(options, force);
    const key = suggestionRequestKey(options);
    if (this.activeSuggestionRequest?.key === key) {
      return this.activeSuggestionRequest.promise;
    }
    const generation = ++this.suggestionGeneration;
    const promise = this.fetchTemplateSuggestions(options, generation).finally(
      () => {
        if (this.activeSuggestionRequest?.promise === promise) {
          this.activeSuggestionRequest = undefined;
        }
      },
    );
    this.activeSuggestionRequest = { key, promise };
    return promise;
  }

  private async fetchTemplateSuggestions(
    options: LoadTemplateSuggestionsOptions,
    generation: number,
  ): Promise<TemplateSuggestionMenuState> {
    const current = this.templateSuggestions$.value;
    this.templateSuggestions$.setValue({
      ...current,
      status: "loading",
      surface: options.surface,
      error: null,
    });

    const graphqlService = this.graphqlService;
    if (this.workspaceService.workspace.flavour === "local") {
      if (this.workspaceService.workspace.flavour === "local")
        await this.setting.loading$.waitFor((loading) => !loading);
      const fallback = this.localSuggestionState(options);
      if (generation === this.suggestionGeneration) {
        this.templateSuggestions$.setValue(fallback);
      }
      return fallback;
    }

    try {
      if (!graphqlService) throw new Error("Template Registry is unavailable");
      const items: TemplateSuggestionItemFieldsFragment[] = [];
      let after: string | undefined;
      let finalResult:
        | {
            emptyDocumentAllowed: boolean;
            reconcileRequired: boolean;
            stale: boolean;
            hasNextPage: boolean;
            endCursor: string | null;
          }
        | undefined;
      for (let page = 0; page < MAX_TEMPLATE_SUGGESTION_PAGES; page++) {
        const response = await graphqlService.gql({
          query: templateSuggestionsQuery,
          variables: {
            workspaceId: this.workspaceService.workspace.id,
            input: {
              surface: options.surface,
              documentTypeId: options.documentTypeId,
              statusId: options.statusId,
              classificationId: options.classificationId,
              mode: options.mode,
              collectionId: options.collectionId,
              currentDocId: options.currentDocId,
              first: options.first ?? DEFAULT_TEMPLATE_SUGGESTION_LIMIT,
              after,
              locale: options.locale ?? "en",
              clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
            },
          },
        });
        if (generation !== this.suggestionGeneration) {
          return this.templateSuggestions$.value;
        }
        const result = response.workspace?.templateSuggestions;
        if (!result) break;
        items.push(...result.items);
        finalResult = {
          ...result,
          reconcileRequired:
            (finalResult?.reconcileRequired ?? false) ||
            result.reconcileRequired,
          stale: (finalResult?.stale ?? false) || result.stale,
        };
        if (!result.hasNextPage) break;
        if (!result.endCursor || result.endCursor === after) {
          throw new Error("Template suggestion continuation did not advance");
        }
        after = result.endCursor;
        if (page === MAX_TEMPLATE_SUGGESTION_PAGES - 1) {
          throw new Error(
            "Template suggestion continuation exceeded its bound",
          );
        }
      }
      const state = mapTemplateSuggestionResult(
        options.surface,
        finalResult ? { ...finalResult, items } : null,
      );
      if (generation === this.suggestionGeneration) {
        if (finalResult) {
          const metadata: Record<string, ResolvedTemplateSourceMetadata> =
            Object.fromEntries(
              Object.entries(this.sourceMetadata$.value.metadata).filter(
                ([, source]) =>
                  !templateCategoryMatchesSurface(
                    source.category,
                    options.surface,
                  ),
              ),
            );
          for (const item of items) {
            const resolved = resolveRegistrySourceMetadata(item);
            if (item.templateDocId && resolved)
              metadata[item.templateDocId] = resolved;
          }
          this.metadataEpoch++;
          this.sourceMetadata$.setValue({
            ...this.sourceMetadata$.value,
            metadata,
          });
        }
        state.items = state.items.filter(
          (item) =>
            templateCategoryMatchesSurface(item.category, options.surface) &&
            categoryFilterAllows(item.category, options.categoryFilter),
        );
        const registryDocIds = new Set(
          state.items.map((item) => item.templateDocId),
        );
        state.items.push(
          ...this.nativeSuggestionItems(options, true).filter(
            (item) => !registryDocIds.has(item.templateDocId),
          ),
        );
        this.templateSuggestions$.setValue(state);
      }
      return state;
    } catch (cause) {
      if (generation !== this.suggestionGeneration) {
        return this.templateSuggestions$.value;
      }
      const state: TemplateSuggestionMenuState = {
        status: "error",
        surface: options.surface,
        items: [],
        emptyDocumentAllowed: true,
        reconcileRequired: false,
        stale: false,
        hasNextPage: false,
        endCursor: null,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      };
      if (generation === this.suggestionGeneration) {
        this.templateSuggestions$.setValue(state);
      }
      return state;
    }
  }

  /** Resolve an exact source independently of the loaded Library page. This read
   * never replaces inventory, classification, pagination or loading state.
   */
  public async lookupTemplateSource(sourceDocId: string, locale: string) {
    const workspace = this.workspaceService.workspace;
    const server = this.workspaceServerService.server;
    if (workspace.flavour === "local" || !server) return null;
    const actor = server.account$.value?.id;
    if (!actor) return null;
    let changedActor = false;
    const subscription = server.account$.subscribe((account) => {
      if (account?.id !== actor) changedActor = true;
    });
    try {
      const response = await server.scope.get(GraphQLService).gql({
        query: templateSuggestionsQuery,
        variables: {
          workspaceId: workspace.id,
          input: {
            surface: TemplateSuggestionSurface.Library,
            first: 1,
            locale,
            clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
            library: { sourceDocId },
          },
        },
      });
      if (
        changedActor ||
        this.workspaceService.workspace !== workspace ||
        this.workspaceServerService.server !== server ||
        server.account$.value?.id !== actor
      )
        return null;
      const items = response.workspace?.templateSuggestions.items;
      if (items?.length !== 1) return null;
      const item = items[0];
      return item.templateDocId === sourceDocId ||
        (!item.available && !item.templateDocId)
        ? item
        : null;
    } finally {
      subscription.unsubscribe();
    }
  }

  /** Resolve a declared manual Library association without reconciliation or content writes. */
  public async resolveAssistantDocumentSource(
    input: Omit<AssistantDocumentSourceInput, "locale" | "clientVersion">,
    locale: string,
  ) {
    const server = this.workspaceServerService.server;
    const workspace = this.workspaceService.workspace;
    if (!server || workspace.flavour === "local") return null;
    const actor = server.account$.value?.id;
    if (!actor) return null;
    let changedActor = false;
    const subscription = server.account$.subscribe((account) => {
      if (account?.id !== actor) changedActor = true;
    });
    try {
      const response = await server.scope.get(GraphQLService).gql({
        query: assistantDocumentSourceQuery,
        variables: {
          workspaceId: workspace.id,
          input: {
            ...input,
            locale,
            clientVersion: TEMPLATE_SUGGESTION_CLIENT_VERSION,
          },
        },
      });
      if (
        changedActor ||
        this.workspaceService.workspace !== workspace ||
        this.workspaceServerService.server !== server ||
        server.account$.value?.id !== actor
      )
        return null;
      return response.workspace?.id === workspace.id
        ? response.workspace.assistantDocumentSource
        : null;
    } finally {
      subscription.unsubscribe();
    }
  }

  /** Check current source membership and the selected materialized revision.
   * Cloud reads bypass picker/Library projections; body revision fences remain
   * owned by the subsequent capture/application boundary.
   */
  public async revalidateTemplateSuggestion(
    templateId: string,
    templateDocId: string,
    options: LoadTemplateSuggestionsOptions,
    sourceRevisionId?: string | null,
  ): Promise<boolean> {
    const source =
      this.workspaceService.workspace.flavour === "local"
        ? (await this.loadTemplateSuggestions(options)).items.find(
            (item) => item.templateDocId === templateDocId,
          )
        : await this.lookupTemplateSource(
            templateDocId,
            options.locale ?? "en",
          );
    return Boolean(
      source?.available &&
      source.templateId === templateId &&
      source.templateDocId === templateDocId &&
      (sourceRevisionId === undefined ||
        source.sourceRevisionId === sourceRevisionId) &&
      templateCategoryMatchesSurface(source.category, options.surface) &&
      categoryFilterAllows(source.category, options.categoryFilter),
    );
  }

  public invalidateTemplateSuggestions(): void {
    this.metadataGeneration++;
    this.metadataRequest = undefined;
    this.sourceMetadata$.setValue({
      inventory: emptySuggestionState(),
      metadata: {},
      key: null,
    });
    this.suggestionGeneration++;
    this.activeSuggestionRequest = undefined;
    this.templateSuggestions$.setValue(emptySuggestionState());
  }

  private localSuggestionState(
    options: LoadTemplateSuggestionsOptions,
  ): TemplateSuggestionMenuState {
    return {
      status: "ready",
      surface: options.surface,
      items: this.nativeSuggestionItems(options),
      emptyDocumentAllowed: true,
      reconcileRequired: false,
      stale: false,
      hasNextPage: false,
      endCursor: null,
      error: null,
    };
  }

  private nativeSuggestionItems(
    options: LoadTemplateSuggestionsOptions,
    customOnly = false,
  ) {
    const metadata = this.resolvedSourceMetadata();
    return this.getTemplateDocs(options.categoryFilter, options.surface)
      .filter(
        (doc) =>
          !customOnly ||
          (metadata[doc.id]?.source === "custom" &&
            !doc.templateAttribution$?.value?.templateId),
      )
      .map((doc) => {
        const item = mapDocRecordToSuggestion(doc, metadata[doc.id]);
        if (
          customOnly &&
          this.list.templateOrigins$.value.get(doc.id) !== "custom"
        ) {
          item.origin = "unknown";
        }
        return item;
      });
  }

  private get serverService() {
    return (
      this.workspaceServerService.server || this.defaultServerService.server
    );
  }

  private get graphqlService() {
    return this.serverService?.scope.get(GraphQLService);
  }
}

export const mapTemplateSuggestionResult = (
  surface: TemplateSuggestionSurface,
  result: {
    items: TemplateSuggestionItemFieldsFragment[];
    emptyDocumentAllowed: boolean;
    reconcileRequired: boolean;
    stale: boolean;
    hasNextPage: boolean;
    endCursor: string | null;
  } | null,
): TemplateSuggestionMenuState => ({
  status: "ready",
  surface,
  items: result?.items.map(mapTemplateSuggestionItem) ?? [],
  emptyDocumentAllowed: result?.emptyDocumentAllowed ?? true,
  reconcileRequired: result?.reconcileRequired ?? false,
  stale: result?.stale ?? false,
  hasNextPage: result?.hasNextPage ?? false,
  endCursor: result?.endCursor ?? null,
  error: null,
});

const suggestionRequestKey = (options: LoadTemplateSuggestionsOptions) =>
  JSON.stringify({
    surface: options.surface,
    documentTypeId: options.documentTypeId,
    statusId: options.statusId,
    classificationId: options.classificationId,
    mode: options.mode,
    collectionId: options.collectionId,
    currentDocId: options.currentDocId,
    first: options.first,
    locale: options.locale,
    categoryFilter: options.categoryFilter,
    library: options.library,
  });

export function templateCategoryMatchesSurface(
  category: string | null | undefined,
  surface: TemplateSuggestionSurface,
) {
  if (surface === TemplateSuggestionSurface.Library) return true;
  if (isBuildingBlockCategory(category))
    return surface === TemplateSuggestionSurface.BuildingBlock;
  if (surface === TemplateSuggestionSurface.BuildingBlock) return false;
  if (
    surface === TemplateSuggestionSurface.JournalOnboarding ||
    surface === TemplateSuggestionSurface.JournalSidebarFooter
  )
    return category === "journal-daily";
  return true;
}

function categoryFilterAllows(
  category: string | null | undefined,
  filter?: TemplateCategoryFilter,
) {
  if (!filter) return true;
  return "include" in filter
    ? category != null && filter.include.includes(category)
    : category == null || !filter.exclude.includes(category);
}

export const mapTemplateSuggestionItem = (
  item: TemplateSuggestionItemFieldsFragment,
): TemplateSuggestionMenuItem => ({
  templateId: item.templateId,
  templateDocId: item.templateDocId,
  title: item.title,
  description: item.description,
  origin:
    item.source === "builtin"
      ? "builtin"
      : item.source === "bundle"
        ? "imported"
        : item.source === "custom"
          ? "custom"
          : "unknown",
  updatedAt: Number.isNaN(Date.parse(item.updatedAt))
    ? null
    : Date.parse(item.updatedAt),
  category: item.category,
  tags: item.tags,
  score: item.score,
  reasons: [...item.reasons],
  instanceState: item.instanceState,
  available: item.available,
  protectedSource: item.protectedSource,
  sourceRevisionId: item.sourceRevisionId,
});

const mapDocRecordToSuggestion = (
  doc: DocRecord,
  metadata?: ResolvedTemplateSourceMetadata,
): TemplateSuggestionMenuItem => ({
  templateId: doc.id,
  templateDocId: doc.id,
  title: doc.meta$.value.title || doc.id,
  description: null,
  origin:
    metadata?.source === "bundle"
      ? "imported"
      : metadata?.source === "builtin"
        ? "builtin"
        : "custom",
  updatedAt: doc.updatedAt$.value ?? null,
  category: metadata?.category ?? null,
  tags: metadata?.tags ?? [],
  score: 0,
  reasons: [],
  instanceState: "local",
  available: true,
  protectedSource: false,
});

/** Use the same category eligibility for ranked and native fallback rows. */
export const applyCategoryFilter = (
  docs: DocRecord[],
  metadata: Record<string, ResolvedTemplateSourceMetadata>,
  filter?: TemplateCategoryFilter,
  surface?: TemplateSuggestionSurface,
): DocRecord[] => {
  return docs.filter((doc) => {
    const category = metadata[doc.id]?.category;
    return (
      categoryFilterAllows(category, filter) &&
      (surface === undefined ||
        templateCategoryMatchesSurface(category, surface))
    );
  });
};

function resolveRegistrySourceMetadata(
  item: TemplateSuggestionItemFieldsFragment,
): ResolvedTemplateSourceMetadata | undefined {
  if (item.source === "custom" || item.source === "unknown")
    return customSourceMetadata(item.templateDocId ?? item.templateId, {
      category: item.category,
      tags: item.tags,
    });
  if (item.source === "builtin") {
    const legacy = nativeSourceMetadata(item.slug);
    return legacy && { ...legacy, category: item.category, tags: item.tags };
  }
  if (item.source !== "bundle" || !item.sourceRevisionId) return undefined;
  const policy = item.titlePolicy;
  if (
    policy !== "template" &&
    policy !== "template-date" &&
    policy !== "date"
  ) {
    throw new Error("Invalid Registry template title policy");
  }
  return {
    slug: item.slug,
    source: "bundle",
    category: item.category,
    tags: item.tags,
    titlePolicy: policy,
    purpose: "template",
  };
}
