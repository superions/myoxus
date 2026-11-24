import { createReferenceIcon } from "@virgultum/core/view/icons";
import { computed, effect, signal } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { EmbedBlockComponent, isEmptyDoc } from "../../embed/index";
import { Peekable } from "@virgultum/core/view/peek";
import { ViewExtensionManagerIdentifier } from "@virgultum/core/extensions";
import { Bound, getCommonBound } from "@virgultum/core/primitives/gfx";
import {
  type DocLinkClickedEvent,
  RefNodeSlotsProvider,
} from "@virgultum/content/inlines";
import {
  type AliasInfo,
  type DocMode,
  type EmbedSyncedDocModel,
  NoteDisplayMode,
  type ReferenceInfo,
} from "@virgultum/core/models";
import { REFERENCE_NODE } from "@virgultum/core/consts";
import {
  DocDisplayMetaProvider,
  DocEmbedProvider,
  DocModeProvider,
  EditorChromeHostIdentifier,
  EditorSettingExtension,
  EditorSettingProvider,
  GeneralSettingSchema,
  ThemeExtensionIdentifier,
  ThemeProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { cloneReferenceInfo } from "@virgultum/core/utils";
import {
  BlockSelection,
  BlockStdScope,
  editorHostSelector,
  type EditorHost,
  LifeCycleWatcher,
} from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  GfxExtension,
} from "@virgultum/core/runtime/gfx";
import {
  type Doc,
  type Store,
  type GetStoreOptions,
  type ExtensionType,
  type Query,
  Text,
  nanoid,
} from "@virgultum/core/store";
import {
  documentReferenceSelectionQuery,
  hasDocumentReferenceSelection,
} from "@virgultum/core/adapters";
import { html, nothing, type PropertyValues } from "lit";
import { query, state } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";
import { classMap } from "lit/directives/class-map.js";
import { guard } from "lit/directives/guard.js";
import { type StyleInfo, styleMap } from "lit/directives/style-map.js";
import * as Y from "yjs";

import type { EmbedSyncedDocCard } from "./components/embed-synced-doc-card.js";
import { blockStyles } from "./styles.js";

@Peekable({
  enableOn: ({ store }: EmbedSyncedDocBlockComponent) => !store.readonly,
})
export class EmbedSyncedDocBlockComponent extends EmbedBlockComponent<EmbedSyncedDocModel> {
  private _referenceIdentity: string | undefined;
  private _referenceScope: ReturnType<
    NonNullable<DocEmbedProvider["inWorkspace"]>
  >;
  private _referenceBinding:
    ReturnType<NonNullable<DocEmbedProvider["openReference"]>> | undefined;
  private get targetContext() {
    const workspaceId = this.model.props.workspaceId ?? this.std.workspace.id;
    const pageId = this.model.props.pageId;
    const provider = this.std.getOptional(DocEmbedProvider);
    const identity = JSON.stringify([workspaceId, pageId]);
    if (identity !== this._referenceIdentity) {
      this._referenceBinding?.dispose();
      this._referenceScope?.dispose();
      this._referenceIdentity = identity;
      this._referenceBinding = provider?.openReference?.(workspaceId, pageId);
      this._referenceScope = this._referenceBinding
        ? undefined
        : provider?.inWorkspace?.(workspaceId);
    }
    if (this._referenceBinding)
      return this._referenceBinding.target.value ?? undefined;
    if (this._referenceScope) return { ...this._referenceScope, docId: pageId };
    if (this.model.props.workspaceId !== undefined || provider?.inWorkspace)
      return undefined;
    return { access: provider, collection: this.std.workspace, docId: pageId };
  }

  private get targetDocId() {
    return this.targetContext?.docId ?? this.model.props.pageId;
  }

  protected _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = blockStyles;

  // Caches total bounds, includes all blocks and elements.
  private _cachedBounds: Bound | null = null;

  private _hasRenderedSyncedView = false;
  private _hasInitedFitEffect = false;

  private readonly _initEdgelessFitEffect = () => {
    const fitToContent = () => {
      if (this.isPageMode) return;

      const controller = this.syncedDocEditorHost?.std.getOptional(
        GfxControllerIdentifier,
      );
      if (!controller) return;

      const viewport = controller.viewport;
      if (!viewport) return;

      if (!this._cachedBounds) {
        this._cachedBounds = getCommonBound([
          ...controller.layer.blocks.map((block) =>
            Bound.deserialize(block.xywh),
          ),
          ...controller.layer.canvasElements,
        ]);
      }

      viewport.onResize();

      const { centerX, centerY, zoom } = viewport.getFitToScreenData(
        this._cachedBounds,
      );
      viewport.setCenter(centerX, centerY);
      viewport.setZoom(zoom);
    };

    const observer = new ResizeObserver(fitToContent);
    const block = this.embedBlock;

    observer.observe(block);

    this._disposables.add(() => {
      observer.disconnect();
    });

    this.syncedDocEditorHost?.updateComplete
      .then(() => fitToContent())
      .catch((e) => console.debug("[embed-synced-doc] fitToContent failed", e));
  };

  private readonly _pageFilter: Query = {
    mode: "loose",
    match: [
      {
        flavour: "myoxus:note",
        props: {
          displayMode: NoteDisplayMode.EdgelessOnly,
        },
        viewType: "hidden",
      },
    ],
  };

  protected _buildPreviewSpec = (name: "preview-page" | "preview-edgeless") => {
    const nextDepth = this.depth + 1;
    const viewExtensionManager = this.std.get(ViewExtensionManagerIdentifier);
    const previewSpec = viewExtensionManager.get(name);
    const currentDisposables = this.disposables;
    const editorSetting = this.std.getOptional(EditorSettingProvider) ?? {
      setting$: signal(GeneralSettingSchema.parse({})),
    };

    class EmbedSyncedDocWatcher extends LifeCycleWatcher {
      static override key = "embed-synced-doc-watcher";
      private readonly _disposables = new DisposableGroup();

      override mounted(): void {
        const { view } = this.std;
        this._disposables.add(
          view.viewUpdated.subscribe((payload) => {
            if (
              payload.type !== "block" ||
              payload.view.model.flavour !== "myoxus:embed-synced-doc"
            ) {
              return;
            }
            const nextComponent = payload.view as EmbedSyncedDocBlockComponent;
            if (payload.method === "add") {
              nextComponent.depth = nextDepth;
              currentDisposables.add(() => {
                nextComponent.depth = 0;
              });
              return;
            }
            if (payload.method === "delete") {
              nextComponent.depth = 0;
              return;
            }
          }),
        );
      }

      override unmounted(): void {
        this._disposables.dispose();
      }
    }

    class GfxViewportInitializer extends GfxExtension {
      static override key = "gfx-viewport-initializer";

      override mounted(): void {
        this.gfx.fitToScreen();
      }
    }

    // A configured preview may already provide chrome. This derived scope must
    // reuse the mounted parent's portal host, rather than register a duplicate
    // or retain a different preview host with an unrelated resource lifetime.
    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    const inheritedChrome: ExtensionType[] = chrome
      ? [
          {
            setup: (di) =>
              di.override(EditorChromeHostIdentifier, () => chrome),
          },
        ]
      : [];
    return previewSpec.concat([
      ...inheritedChrome,
      EmbedSyncedDocWatcher,
      GfxViewportInitializer,
      EditorSettingExtension(editorSetting),
    ]);
  };

  protected _renderSyncedView = () => {
    const syncedDoc = this.syncedDoc;
    const editorMode = this.editorMode;
    const isPageMode = this.isPageMode;

    if (!syncedDoc) {
      console.error("Synced doc is not found");
      return html`${nothing}`;
    }

    if (isPageMode) {
      this.dataset.pageMode = "";
    }

    const containerStyleMap = styleMap({
      position: "relative",
      width: "100%",
    });

    const themeService = this.std.get(ThemeProvider);
    const themeExtension = this.std.getOptional(ThemeExtensionIdentifier);
    const appTheme = themeService.app$.value;
    let edgelessTheme = themeService.edgeless$.value;
    if (themeExtension?.getEdgelessTheme && this.syncedDoc?.id) {
      edgelessTheme = themeExtension.getEdgelessTheme(this.syncedDoc.id).value;
    }
    const theme = isPageMode ? appTheme : edgelessTheme;

    this.dataset.nestedEditor = "";

    const renderEditor = () => {
      return choose(editorMode, [
        [
          "page",
          () => html`
            <div class="myoxus-page-viewport" data-theme=${appTheme}>
              ${new BlockStdScope({
                store: syncedDoc,
                extensions: this._buildPreviewSpec("preview-page"),
              }).render()}
            </div>
          `,
        ],
        [
          "edgeless",
          () => html`
            <div class="myoxus-edgeless-viewport" data-theme=${edgelessTheme}>
              ${new BlockStdScope({
                store: syncedDoc,
                extensions: this._buildPreviewSpec("preview-edgeless"),
              }).render()}
            </div>
          `,
        ],
      ]);
    };

    return this.renderEmbed(
      () => html`
        <div
          class=${classMap({
            "myoxus-embed-synced-doc-container": true,
            [editorMode]: true,
            [theme]: true,
            surface: false,
            "selected-reference": hasDocumentReferenceSelection(
              this.model.props.params,
            ),
            selected: this.selected$.value,
            "show-hover-border": true,
            "comment-highlighted": this.isCommentHighlighted,
          })}
          @click=${this._handleClick}
          style=${containerStyleMap}
          ?data-scale=${undefined}
        >
          <div class="myoxus-embed-synced-doc-editor">
            ${
              isPageMode && this._isEmptySyncedDoc
                ? html`
                    <div class="myoxus-embed-synced-doc-editor-empty">
                      <span
                        >${this._text(editorMessage("com.myoxus.editor.embed.synced-empty-hint", "This is a linked doc, you can add content here."))}</span
                      >
                    </div>
                  `
                : guard(
                    [editorMode, syncedDoc, appTheme, edgelessTheme],
                    renderEditor,
                  )
            }
          </div>
          <div
            class=${classMap({
              "myoxus-embed-synced-doc-header-wrapper": true,
              selected: this.selected$.value,
            })}
          >
            <div class="myoxus-embed-synced-doc-header">
              <span class="myoxus-embed-synced-doc-icon"
                >${this.icon$.value}</span
              >
              <span class="myoxus-embed-synced-doc-title">${this.title$}</span>
            </div>
          </div>
        </div>
      `,
    );
  };

  protected cardStyleMap = styleMap({
    position: "relative",
    display: "block",
    width: "100%",
  });

  convertToCard = (aliasInfo?: AliasInfo) => {
    const { store } = this.model;
    if (store.readonly) return;
    const { caption } = this.model.props;

    const parent = store.getParent(this.model);
    if (!parent) {
      console.error(
        `Trying to convert synced doc to card, but the parent is not found.`,
      );
      return;
    }
    const index = parent.children.indexOf(this.model);

    const blockId = store.addBlock(
      "myoxus:embed-linked-doc",
      { caption, ...this.referenceInfo, ...aliasInfo },
      parent,
      index,
    );

    store.deleteBlock(this.model);

    this.std.selection.setGroup("note", [
      this.std.selection.create(BlockSelection, { blockId }),
    ]);
  };

  convertToInline = () => {
    const { store } = this.model;
    if (store.readonly) return;
    const parent = store.getParent(this.model);
    if (!parent) {
      console.error(
        `Trying to convert synced doc to inline, but the parent is not found.`,
      );
      return;
    }
    const index = parent.children.indexOf(this.model);

    const yText = new Y.Text();
    yText.insert(0, REFERENCE_NODE);
    yText.format(0, REFERENCE_NODE.length, {
      reference: {
        type: "LinkedPage",
        ...this.referenceInfo,
      },
    });
    const text = new Text(yText);

    store.addBlock(
      "myoxus:paragraph",
      {
        text,
      },
      parent,
      index,
    );

    store.deleteBlock(this.model);
  };

  protected override embedContainerStyle: StyleInfo = {
    height: "unset",
  };

  icon$ = computed(() => {
    const { params } = this.model.props;
    const pageId = this.targetDocId;
    const context = this.targetContext;
    if (
      !context ||
      (context.access && context.access.readable(pageId).value !== true)
    )
      return nothing;
    if (context.collection.id !== this.std.workspace.id)
      return createReferenceIcon(this.ownerDocument, "LinkIcon");
    return createReferenceIcon(
      this.ownerDocument,
      this.std.get(DocDisplayMetaProvider).referenceIcon(pageId, params),
    );
  });

  open = (event?: Partial<DocLinkClickedEvent>) => {
    const pageId = this.targetDocId;
    if (
      pageId === this.store.id &&
      (this.targetContext?.collection.id ??
        this.model.props.workspaceId ??
        this.std.workspace.id) === this.std.workspace.id
    )
      return;
    if (this.targetContext?.access?.readable(pageId).value !== true) return;

    this.std.getOptional(RefNodeSlotsProvider)?.docLinkClicked.next({
      ...event,
      pageId,
      workspaceId:
        this.targetContext?.collection.id ?? this.model.props.workspaceId,
      params: this.model.props.params,
      host: this.host,
    });
  };

  refreshData = () => {
    this._load()
      .then(() => {
        this._isEmptySyncedDoc = isEmptyDoc(this.syncedDoc, this.editorMode);
      })
      .catch((e) => {
        console.debug("[embed-synced-doc] Preview unavailable", e);
        this._releaseSelectionView();
        this._error = true;
        this._loading = false;
      });
  };

  title$ = computed(() => {
    const { params } = this.model.props;
    const context = this.targetContext;
    const pageId = context?.docId ?? this.model.props.pageId;
    if (
      !context ||
      (context.access && context.access.readable(pageId).value !== true)
    )
      return "";
    if (context.collection.id !== this.std.workspace.id)
      return context.access?.referenceTitleSignal?.(pageId)?.value ?? "";
    return this.std.get(DocDisplayMetaProvider).title(pageId, {
      params,
      title: this.model.props.title,
      referenced: true,
    }).value;
  });

  get blockState() {
    return {
      isLoading: this._loading,
      isError: this._error,
      isDeleted: this._deleted,
      isCycle: this._cycle,
    };
  }

  get docTitle() {
    return (
      this.syncedDoc?.meta?.title ||
      this._text(editorMessage("Untitled", "Untitled"))
    );
  }

  get docUpdatedAt() {
    return this.targetContext?.access?.readable(this.targetDocId).value === true
      ? this._docUpdatedAt
      : null;
  }

  get editorMode() {
    return this.linkedMode ?? this.syncedDocMode;
  }

  protected get isPageMode() {
    return this.editorMode === "page";
  }

  get linkedMode() {
    return this.referenceInfo.params?.mode;
  }

  get referenceInfo(): ReferenceInfo {
    const context = this.targetContext;
    return cloneReferenceInfo({
      ...this.model.props,
      pageId: context?.docId ?? this.model.props.pageId,
      workspaceId: context?.collection.id ?? this.model.props.workspaceId,
    });
  }

  private readonly _selectionViewId = nanoid();
  private _selectionGeneration = 0;
  private _selectionSource?: {
    doc: Doc;
    store: Store;
    options: GetStoreOptions;
  };
  private _selectionView?: {
    doc: Doc;
    store: Store;
    options: GetStoreOptions;
    generation: string;
    query: string;
  };

  private _releaseSelectionView() {
    const current = this._selectionView;
    this._selectionView = undefined;
    if (current) {
      current.store.dispose();
      current.doc.removeStore(current.options);
    }
  }

  private _selectionSourceStore(doc: Doc) {
    if (this._selectionSource?.doc === doc) return this._selectionSource.store;
    this._releaseSelectionSource();
    const options = { readonly: true, id: `${this._selectionViewId}:source` };
    const store = doc.getStore(options);
    this._selectionSource = { doc, store, options };
    return store;
  }

  private _releaseSelectionSource() {
    this._releaseSelectionView();
    const source = this._selectionSource;
    this._selectionSource = undefined;
    if (source) {
      source.store.dispose();
      source.doc.removeStore(source.options);
    }
  }

  get syncedDoc() {
    try {
      return this._resolveSyncedDoc();
    } catch {
      // Render reads the same getter as loading. An invalidated selection must
      // render the existing error card instead of leaving the previous Lit tree.
      this._releaseSelectionView();
      this._error = true;
      return null;
    }
  }

  private _resolveSyncedDoc() {
    const context = this.targetContext;
    if (!context) {
      this._releaseSelectionSource();
      return null;
    }
    const access = context.access;
    if (access && access.readable(this.targetDocId).value !== true) {
      this._releaseSelectionSource();
      return null;
    }
    const options: GetStoreOptions = { readonly: true };
    if (this.isPageMode) options.query = this._pageFilter;
    const doc = context.collection.getDoc(context.docId);
    if (!doc) {
      this._releaseSelectionSource();
      return null;
    }
    const params = this.model.props.params;
    const selected = hasDocumentReferenceSelection(params);
    if (!selected) {
      this._releaseSelectionSource();
      return doc.getStore(options);
    }
    if (!this.isPageMode)
      throw new Error("Selected document preview requires Page mode");
    const generation = JSON.stringify([params, this._selectionGeneration]);
    const previous = this._selectionView;
    if (previous?.doc === doc && previous.generation === generation)
      return previous.store;
    const source = this._selectionSourceStore(doc);
    if (!source.root) throw new Error("Selected document target unavailable");
    const transformer = source.getTransformer([]);
    let query: Query;
    try {
      const snapshot = transformer.docToSnapshot(source);
      if (!snapshot) throw new Error("Selected document target unavailable");
      query = documentReferenceSelectionQuery(snapshot, params);
    } finally {
      transformer[Symbol.dispose]();
    }
    const key = JSON.stringify(query);
    if (previous?.doc === doc && previous.query === key) {
      previous.generation = generation;
      return previous.store;
    }
    // This is an owned readonly view over the same Y.Doc, not copied content.
    // Remove retired views from the native container as section boundaries move.
    this._releaseSelectionView();
    const selectedOptions: GetStoreOptions = {
      readonly: true,
      id: this._selectionViewId,
      query,
    };
    const store = doc.getStore(selectedOptions);
    this._selectionView = {
      doc,
      store,
      options: selectedOptions,
      generation,
      query: key,
    };
    return store;
  }

  private _checkCycle() {
    let editorHost: EditorHost | null = this.host;
    while (editorHost && !this._cycle) {
      this._cycle =
        !!editorHost &&
        editorHost.store.id === this.targetDocId &&
        editorHost.store.workspace.id ===
          (this.targetContext?.collection.id ??
            this.model.props.workspaceId ??
            this.std.workspace.id);
      editorHost =
        editorHost.parentElement?.closest<EditorHost>(editorHostSelector) ??
        null;
    }
  }

  private _isClickAtBorder(
    event: MouseEvent,
    element: HTMLElement,
    tolerance = 8,
  ): boolean {
    const { x, y } = event;
    const rect = element.getBoundingClientRect();
    if (!rect) {
      return false;
    }

    return (
      Math.abs(x - rect.left) < tolerance ||
      Math.abs(x - rect.right) < tolerance ||
      Math.abs(y - rect.top) < tolerance ||
      Math.abs(y - rect.bottom) < tolerance
    );
  }

  private _loadAbort?: AbortController;
  private _targetDisposables = new DisposableGroup();

  private async _load() {
    // A changed relation/access projection owns a new attempt. Cancel both the
    // host wait and target subscriptions before touching the new target.
    this._loadAbort?.abort();
    const attempt = new AbortController();
    this._loadAbort = attempt;
    this._targetDisposables.dispose();
    this._targetDisposables = new DisposableGroup();
    this._loading = true;
    this._error = false;
    this._deleted = false;
    this._cycle = false;

    // Track authored selection changes before the asynchronous load boundary.
    void this.model.props.params;

    const context = this.targetContext;
    const pageId = context?.docId ?? this.model.props.pageId;
    if (!context) {
      this._releaseSelectionView();
      this._loading =
        !!this._referenceBinding &&
        this._referenceBinding.target.value === undefined;
      this._error = !this._loading;
      return;
    }
    const access = context.access;
    const readable = access?.readable(pageId).value;
    if (access && readable !== true) {
      this._releaseSelectionView();
      this._error = readable === false;
      this._loading = readable === undefined;
      return;
    }

    let watchedDoc: Doc | undefined;
    const watchTarget = () => {
      const sourceDoc = context.collection.getDoc(pageId);
      if (!sourceDoc || sourceDoc === watchedDoc) return;
      watchedDoc = sourceDoc;
      let refreshQueued = false;
      const refresh = () => {
        if (refreshQueued) return;
        refreshQueued = true;
        // Project after every native Store has observed this transaction. Store
        // deletion slots run before model removal and cannot define that boundary.
        queueMicrotask(() => {
          refreshQueued = false;
          if (attempt.signal.aborted) return;
          this._selectionGeneration++;
          const current = this.syncedDoc;
          this._isEmptySyncedDoc = isEmptyDoc(current, this.editorMode);
          this._error = !current;
          this.requestUpdate();
        });
      };
      sourceDoc.spaceDoc.on("afterTransaction", refresh);
      this._targetDisposables.add(() =>
        sourceDoc.spaceDoc.off("afterTransaction", refresh),
      );
    };
    watchTarget();

    // A granted target may not have a materialized native store in this pool yet.
    // Load through its host owner before treating a missing cache entry as deletion.
    if (access) {
      try {
        await access.waitForLoaded(
          pageId,
          AbortSignal.any([attempt.signal, AbortSignal.timeout(30_000)]),
        );
      } catch {
        if (attempt.signal.aborted) return;
        this._error = true;
        this._loading = false;
        return;
      }
      if (attempt.signal.aborted) return;
      if (access.readable(pageId).value !== true) {
        this._error = true;
        this._loading = false;
        return;
      }
    }

    watchTarget();

    const syncedDoc = this.syncedDoc;
    const trash = syncedDoc?.meta?.trash;
    if (trash || !syncedDoc) {
      this._deleted = !this._error;
      this._loading = false;
      return;
    }

    this._checkCycle();
    if (this._cycle || this.depth >= 1) {
      this._loading = false;
      return;
    }

    const foreign = context.collection.id !== this.std.workspace.id;
    const mode = foreign ? undefined : this.std.getOptional(DocModeProvider);
    if (!this.linkedMode && foreign && access?.primaryMode) {
      const primaryMode = access.primaryMode(pageId);
      this._targetDisposables.add(
        effect(() => {
          this.syncedDocMode = primaryMode.value ?? "page";
        }),
      );
    }
    if (!this.linkedMode && mode) {
      this.syncedDocMode = mode.getPrimaryMode(pageId);
      this._targetDisposables.add(
        mode.onPrimaryModeChange((next) => {
          this.syncedDocMode = next;
          this._isEmptySyncedDoc = isEmptyDoc(this.syncedDoc, this.editorMode);
        }, pageId),
      );
    }

    if (access) {
      this._error = !syncedDoc.root;
      this._isEmptySyncedDoc = isEmptyDoc(syncedDoc, this.editorMode);
      this._loading = false;
      return;
    }

    if (!syncedDoc.loaded) {
      try {
        syncedDoc.load();
      } catch (e) {
        console.error(e);
        this._error = true;
      }
    }

    if (!this._error && !syncedDoc.root) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          subscription.unsubscribe();
          attempt.signal.removeEventListener("abort", finish);
          resolve();
        };
        const subscription = syncedDoc.slots.rootAdded.subscribe(() => {
          finish();
        });
        attempt.signal.addEventListener("abort", finish, { once: true });
      });
    }
    if (attempt.signal.aborted) return;
    this._isEmptySyncedDoc = isEmptyDoc(this.syncedDoc, this.editorMode);
    this._loading = false;
  }

  private _selectBlock() {
    const selectionManager = this.std.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  }

  private _setDocUpdatedAt() {
    const context = this.targetContext;
    const meta =
      context?.access?.readable(context.docId).value === true
        ? context.collection.meta.getDocMeta(context.docId)
        : undefined;
    if (meta) {
      const date = meta.updatedDate || meta.createDate;
      this._docUpdatedAt = new Date(date);
    }
  }

  protected _handleClick(_event: MouseEvent) {
    this._selectBlock();
  }

  override connectedCallback() {
    super.connectedCallback();
    this._cardStyle = this.model.props.style;

    this.style.display = "block";
    this.contentEditable = "false";
    this.disposables.add(
      effect(() => {
        this._cardStyle = this.model.props.style;
        // _load reads the relation and access signal before its first await.
        this.refreshData();
      }),
    );
    this.disposables.add(() => {
      this._loadAbort?.abort();
      this._referenceBinding?.dispose();
      this._referenceIdentity = undefined;
      this._referenceScope?.dispose();
      this._referenceScope = undefined;
      this._targetDisposables.dispose();
      this._releaseSelectionSource();
    });

    this._setDocUpdatedAt();
    this.disposables.add(
      this.store.workspace.slots.docListUpdated.subscribe(() => {
        this._setDocUpdatedAt();
        this.refreshData();
      }),
    );
  }

  override firstUpdated() {
    this.disposables.addFromEvent(this, "click", (e) => {
      e.stopPropagation();
      if (this._isClickAtBorder(e, this)) {
        e.preventDefault();
        this._selectBlock();
      }
    });
  }

  override renderBlock() {
    delete this.dataset.nestedEditor;

    const syncedDoc = this.syncedDoc;
    const { isLoading, isError, isDeleted, isCycle } = this.blockState;
    const isCardOnly = this.depth >= 1;

    if (
      isLoading ||
      isError ||
      isDeleted ||
      isCardOnly ||
      isCycle ||
      !syncedDoc
    ) {
      return this.renderEmbed(
        () => html`
          <myoxus-embed-synced-doc-card
            style=${this.cardStyleMap}
            .block=${this}
          ></myoxus-embed-synced-doc-card>
        `,
        "native",
      );
    }

    !this._hasRenderedSyncedView && (this._hasRenderedSyncedView = true);

    return this._renderSyncedView();
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    this.syncedDocCard?.requestUpdate();

    if (!this._hasInitedFitEffect && this._hasRenderedSyncedView) {
      /* Register the resizeObserver AFTER syncdView viewport's own resizeObserver
       * so that viewport.onResize() use up-to-date boundingClientRect values */
      this._hasInitedFitEffect = true;
      this._initEdgelessFitEffect();
    }
  }

  @state()
  private accessor _cycle = false;

  @state()
  private accessor _deleted = false;

  @state()
  private accessor _docUpdatedAt: Date = new Date();

  @state()
  private accessor _error = false;

  @state()
  protected accessor _isEmptySyncedDoc: boolean = true;

  @state()
  private accessor _loading = false;

  @state()
  accessor depth = 0;

  @query(
    ":scope > .myoxus-block-component > .embed-block-container > myoxus-embed-synced-doc-card",
  )
  accessor syncedDocCard: EmbedSyncedDocCard | null = null;

  @query(
    ":scope > .myoxus-block-component > .embed-block-container > .myoxus-embed-synced-doc-container > .myoxus-embed-synced-doc-editor > div > editor-host",
  )
  accessor syncedDocEditorHost: EditorHost | null = null;

  @state()
  accessor syncedDocMode: DocMode = "page";

  override accessor useCaptionEditor = true;
}
