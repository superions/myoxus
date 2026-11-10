/** Native offline delivery and read-only projection of retained Registry bindings.
 * Cloud document creation, updates and retirement belong to the server. */
import { DebugLogger } from "@myoxus/debug";
import {
  WorkspaceInitialContentPolicy,
  templateSuggestionsQuery,
  TemplateSuggestionSurface,
  workspaceTemplateReconcileSlugsMutation,
} from "@myoxus/graphql";
import { I18n } from "@myoxus/i18n";
import { LiveData, Service } from "@myoxus/infra";
import { onTemplateReconcileNeeded } from "@myoxus/storage/cloud";
import { filter, firstValueFrom, timeout } from "rxjs";
import {
  nativeDocumentBundles,
  retiredDocumentSlugs,
  nativeSourceMetadata,
  type ResolvedTemplateSourceMetadata,
} from "./source-metadata";
import { readNativeTemplateBundle } from "./native-bundle";
import { waitForTemplateOperation } from "./template-instantiation-error";

import type { DocsService } from "../../doc";
import type { WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";
import { TemplateDocSetting } from "../entities/setting";
const logger = new DebugLogger("BuiltinTemplateReconciler");

/**
 * Single entry returned by `workspaceTemplateReconcileSlugsMutation`.
 * Mirrors the GraphQL `BuiltinReconcileEntryType` but kept local so the
 * reconciler logic doesn't leak GraphQL types into helper signatures.
 */
interface ReconcileEntry {
  slug: string;
  workspaceDocId: string | null;
  instanceState:
    "Ok" | "UpdateAvailable" | "Detached" | "Retired" | "Error" | null;
  provisioningMode: "SeedOnce" | "ManagedUntilLocalEdit" | "ManualUpdate";
  hasInstance: boolean;
}

export interface BuiltinTemplateBinding {
  slug: string;
  docId: string;
  state: NonNullable<ReconcileEntry["instanceState"]>;
  metadata?: ResolvedTemplateSourceMetadata;
}

export class BuiltinTemplateReconcilerService extends Service {
  private readonly deliveryAbort = new AbortController();
  /** Memoised whole-run promise. Reset to `null` once the run resolves so
   *  the next caller starts a fresh pass. */
  private currentRun: Promise<void> | null = null;
  private currentRunProvisions = false;

  /** Unsubscribe handle for the socket subscription, called on dispose. */
  private readonly unsubscribeSocket: () => void;
  /** Unsubscribe handle for the i18n locale-change watcher (W-03). */
  private readonly unsubscribeLocale: () => void;
  /** Last seen locale; used to ignore the redundant fire of
   *  `languageChanged` that i18next emits on initial load. */
  private lastSeenLocale: string;

  private readonly setting = this.framework.createEntity(TemplateDocSetting);
  /** Read-only cloud projection used for picker category and title policy. */
  readonly bindings$ = new LiveData<Record<string, BuiltinTemplateBinding>>({});

  private get requiredServer() {
    const server = this.workspaceServerService.server;
    if (!server) {
      throw new Error("Workspace server is not available");
    }
    return server;
  }

  constructor(
    private readonly docsService: DocsService,
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
    this.unsubscribeSocket = onTemplateReconcileNeeded((payload) => {
      if (payload.workspaceId !== this.workspaceId) return;
      logger.debug("Socket trigger for workspace", payload);
      this.reconcile().catch((err) => {
        logger.warn("Reconcile from socket trigger failed", err);
      });
    });

    // Refresh server readiness after a locale change. An existing shared
    // source keeps its content and original creation locale.
    this.lastSeenLocale = I18n.language || "en";
    const onLocaleChange = (lng: string) => {
      if (lng === this.lastSeenLocale) return;
      const prev = this.lastSeenLocale;
      this.lastSeenLocale = lng;
      logger.info("Locale change — triggering reconcile", {
        from: prev,
        to: lng,
      });
      this.reconcile().catch((err) => {
        logger.warn("Reconcile from locale-change failed", err);
      });
    };
    I18n.on("languageChanged", onLocaleChange);
    this.unsubscribeLocale = () => I18n.off("languageChanged", onLocaleChange);
  }

  override dispose(): void {
    this.deliveryAbort.abort();
    super.dispose();
    this.unsubscribeSocket();
    this.unsubscribeLocale();
  }

  private get workspaceId(): string {
    return this.workspaceService.workspace.id;
  }

  /**
   * Public entrypoint. Idempotent and race-safe: concurrent calls share
   * the same promise. Delivery errors reject the callers; the promise is reset
   * after failure so a later request can retry without a builder fallback.
   */
  reconcile(provisionSources = false): Promise<void> {
    // An in-flight passive binding read cannot fulfill an explicit repair.
    // Concurrent repair callers join the following provision pass instead.
    if (provisionSources && this.currentRun && !this.currentRunProvisions) {
      return this.currentRun.then(() => this.reconcile(true));
    }
    if (!this.currentRun) {
      this.currentRunProvisions = provisionSources;
      this.currentRun = this.runReconcile(provisionSources).finally(() => {
        this.currentRun = null;
        this.currentRunProvisions = false;
      });
    }
    return this.currentRun;
  }

  /**
   * Ensure a workspace has the requested builtin template documents and return
   * their live `slug -> docId` mapping.
   *
   * Server-backed workspaces use the normal policy-driven reconcile path, so
   * `template_default_policies` remains the source of truth for automatic
   * seeding. Local workspaces import committed native bundles offline;
   * no document bodies are built at runtime.
   */
  async ensureBuiltinTemplatesSeeded(
    slugs: readonly string[],
  ): Promise<Record<string, string>> {
    await firstValueFrom(this.setting.loading$.pipe(filter((l) => !l)));

    if (this.workspaceService.workspace.flavour !== "local") {
      if (!this.workspaceServerService.server) {
        throw new Error("Workspace Template Registry is not available");
      }
      await this.reconcile();
      return this.readDeliveredGuideDocIds(slugs);
    }

    slugs = slugs.filter((slug) => !retiredDocumentSlugs.includes(slug));
    if (!slugs.length) return {};
    // First-open and picker requests share the same acknowledged delivery run.
    // Complete the native catalog once; expose only the requested live bindings.
    await this.reconcile();
    return this.readLiveBuiltinDocIds(slugs);
  }

  /** Wait for the existing server delivery and sync lifecycle; this read path
   * never builds cloud guides or repairs a deleted reader's binding locally. */
  private async readDeliveredGuideDocIds(slugs: readonly string[]) {
    const signal = AbortSignal.any([
      this.deliveryAbort.signal,
      AbortSignal.timeout(30_000),
    ]);
    const workspace = this.workspaceService.workspace;
    while (true) {
      signal.throwIfAborted();
      const result = await waitForTemplateOperation(
        this.requiredServer.gql({
          query: templateSuggestionsQuery,
          variables: {
            workspaceId: workspace.id,
            input: {
              surface: TemplateSuggestionSurface.SidebarNewPage,
              locale: I18n.language || "en",
              clientVersion: 1,
              first: 1,
            },
          },
        }),
        signal,
      );
      const projection = result.workspace?.templateSuggestions;
      if (!projection)
        throw new Error("Workspace Template Registry is not available");
      const deliveries = projection.guideDeliveries.filter((delivery) =>
        slugs.includes(delivery.slug),
      );
      await workspace.engine.doc.waitForSynced(workspace.id, signal);
      const ids = this.readLiveBuiltinDocIds(slugs);
      let ready = true;
      for (const delivery of deliveries) {
        delete ids[delivery.slug];
        if (delivery.pending) ready = false;
        if (delivery.documentId) {
          await workspace.engine.doc.waitForSynced(delivery.documentId, signal);
          if (this.isLiveTemplateDocument(delivery.documentId))
            ids[delivery.slug] = delivery.documentId;
          else ready = false;
        }
      }
      if (ready) return ids;
      await waitForTemplateOperation(
        new Promise<void>((resolve) => setTimeout(resolve, 300)),
        signal,
      );
    }
  }

  private readLiveBuiltinDocIds(
    slugs: readonly string[],
  ): Record<string, string> {
    const localMap =
      this.workspaceService.workspace.flavour === "local"
        ? (this.setting.builtinTemplateInstanceDocIds$.value ?? {})
        : Object.fromEntries(
            Object.values(this.bindings$.value).map((binding) => [
              binding.slug,
              binding.docId,
            ]),
          );
    const result: Record<string, string> = {};
    for (const slug of slugs) {
      const docId = localMap[slug];
      if (docId && this.isLiveTemplateDocument(docId)) {
        result[slug] = docId;
      }
    }
    return result;
  }

  private async seedLocalBuiltinTemplates(
    slugs: readonly string[],
    locale: string,
  ): Promise<Record<string, string>> {
    const nextMap = {
      ...this.setting.builtinTemplateInstanceDocIds$.value,
    };
    // Retire delivery bindings, not the user's existing document/template.
    for (const slug of retiredDocumentSlugs) delete nextMap[slug];
    slugs = slugs.filter((slug) => !retiredDocumentSlugs.includes(slug));
    const liveBefore = this.readLiveBuiltinDocIds(slugs);

    for (const slug of slugs) {
      if (liveBefore[slug]) continue;
      const bundle = nativeDocumentBundles.find(
        (entry) => entry.template_id === slug,
      );
      if (bundle) {
        // A delivery binding suppresses automatic recreation after a reader
        // deletes a guide. Neither language nor bundle changes refresh copies.
        if (nextMap[slug]) continue;
        const selected = await readNativeTemplateBundle(
          bundle,
          locale,
          async (asset) => {
            const response = await fetch(
              `${environment.publicPath}document-bundles/${asset}`,
            );
            if (!response.ok)
              throw new Error("Native document payload is unavailable");
            return new Uint8Array(await response.arrayBuffer());
          },
        );
        const imported = await this.docsService.importNativeTemplateDoc(
          selected.content,
          selected.title,
          selected.manifest.purpose ?? "template",
        );
        const docId = imported.id;
        try {
          // Persist each acknowledged delivery before continuing: a later
          // bundle failure must not duplicate already delivered guide pages.
          nextMap[slug] = docId;
          this.setting.setBuiltinTemplateInstanceDocIds({ ...nextMap });
        } catch (error) {
          this.docsService.moveManyToTrash([docId]);
          throw error;
        }
        continue;
      }
      throw new Error(`Native document bundle is not registered: ${slug}`);
    }

    this.setting.setBuiltinTemplateInstanceDocIds(nextMap);
    return this.readLiveBuiltinDocIds(slugs);
  }

  private async runReconcile(provisionSources: boolean): Promise<void> {
    if (!this.workspaceServerService.server) {
      if (this.workspaceService.workspace.flavour === "local") {
        // Empty is a permanent Workspace policy, including locale/Library
        // reconciliation. Explicit Library instantiation has its own command.
        if (
          this.workspaceService.workspace.meta.initialContentPolicy ===
          WorkspaceInitialContentPolicy.Empty
        )
          return;
        // Library and locale triggers call reconcile directly. Read persisted
        // delivery bindings before seeding, otherwise a cold local store looks
        // empty and creates additional copies of already delivered documents.
        await firstValueFrom(
          this.setting.loading$.pipe(
            filter((loading) => !loading),
            timeout({ first: 30_000 }),
          ),
        );
        await this.seedLocalBuiltinTemplates(
          nativeDocumentBundles.map((bundle) => bundle.template_id),
          I18n.language || "en",
        );
      }
      return;
    }

    const locale = I18n.language || "en";
    const workspaceId = this.workspaceId;

    let entries: ReconcileEntry[];
    try {
      const result = await this.workspaceServerService.server.gql({
        query: workspaceTemplateReconcileSlugsMutation,
        variables: {
          workspaceId,
          locale,
          ...(provisionSources ? { provisionSources: true } : {}),
        },
      });
      entries = result.workspaceTemplateReconcileSlugs as ReconcileEntry[];
    } catch (err) {
      if (provisionSources) throw err;
      logger.warn("Failed to fetch reconcile entries — skipping run", err);
      return;
    }

    this.bindings$.next(this.projectBindings(entries));
    await this.refreshPageDefaultReplacements(locale);
    // Retained builtin transport can still describe pre-cutover bindings, but
    // current clients never build, replace or report cloud document content.
  }

  private async refreshPageDefaultReplacements(locale: string) {
    try {
      const result = await this.workspaceServerService.server!.gql({
        query: templateSuggestionsQuery,
        variables: {
          workspaceId: this.workspaceId,
          input: {
            surface: TemplateSuggestionSurface.SidebarNewPage,
            locale,
            clientVersion: 1,
            first: 1,
          },
        },
      });
      await this.applyPageDefaultReplacements(
        result.workspace?.templateSuggestions.pageDefaultReplacements ?? [],
      );
    } catch (error) {
      logger.warn("Failed to read replaced page-template preferences", error);
    }
  }

  /** Consume a ready contextual response without issuing another suggestion read.
   * Only existing compare-and-set preference migration belongs here, never copies.
   */
  public async applyPageDefaultReplacements(
    replacements: readonly {
      retiredSourceDocId: string;
      replacementSourceDocId?: string | null;
    }[],
    isCurrent: () => boolean = () => true,
  ) {
    if (!replacements.length) return;
    try {
      await firstValueFrom(
        this.setting.loading$.pipe(filter((loading) => !loading)),
      );
      for (const replacement of replacements) {
        if (!isCurrent()) return;
        await this.setting.replacePageTemplateDocId(
          replacement.retiredSourceDocId,
          replacement.replacementSourceDocId ?? undefined,
        );
        if (!isCurrent()) return;
        await this.setting.replaceJournalTemplateDocId(
          replacement.retiredSourceDocId,
          replacement.replacementSourceDocId ?? undefined,
        );
      }
    } catch (error) {
      logger.warn(
        "Failed to converge replaced page-template preference",
        error,
      );
    }
  }

  private projectBindings(entries: ReconcileEntry[]) {
    return Object.fromEntries(
      entries.flatMap((entry) =>
        entry.hasInstance && entry.workspaceDocId && entry.instanceState
          ? [
              [
                entry.workspaceDocId,
                {
                  slug: entry.slug,
                  docId: entry.workspaceDocId,
                  state: entry.instanceState,
                  metadata: nativeSourceMetadata(entry.slug),
                } satisfies BuiltinTemplateBinding,
              ],
            ]
          : [],
      ),
    );
  }

  private isLiveTemplateDocument(docId: string) {
    const doc = this.docsService.list.doc$(docId).value;
    return Boolean(doc && !doc.trash$.value);
  }
}
