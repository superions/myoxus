import { DocEmbedProvider, EditorI18nProvider } from "@virgultum/core/services";
import { effect, signal, untracked } from "@preact/signals-core";
import { FrameBlockComponent } from "../frame/index";
import {
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
} from "@virgultum/canvas-runtime/surface";
import type { BlockCaptionEditor } from "@virgultum/content/caption";
import { whenHover } from "@virgultum/core/view/hover";
import { Peekable } from "@virgultum/core/view/peek";
import { ViewExtensionManagerIdentifier } from "@virgultum/core/extensions";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  ErrorCode,
  VirgultumError,
} from "@virgultum/core/primitives/exceptions";
import { Bound, type SerializedXYWH } from "@virgultum/core/primitives/gfx";
import { RefNodeSlotsProvider } from "@virgultum/content/inlines";
import {
  FrameBlockModel,
  type SurfaceRefBlockModel,
} from "@virgultum/core/models";
import {
  BlockElementCommentManager,
  DocModeProvider,
  EditPropsStore,
  type OpenDocMode,
  ThemeProvider,
  ToolbarRegistryIdentifier,
  ViewportElementExtension,
} from "@virgultum/core/services";
import { requestConnectedFrame } from "@virgultum/core/utils";
import {
  BlockSelection,
  BlockStdScope,
  type EditorHost,
  installEditorStyles,
  LifeCycleWatcher,
  NativeBlockComponent,
  TextSelection,
} from "@virgultum/core/runtime";
import {
  GfxBlockElementModel,
  GfxControllerIdentifier,
  type GfxModel,
  GfxPrimitiveElementModel,
} from "@virgultum/core/runtime/gfx";
import type {
  BaseSelection,
  ExtensionType,
  Store,
} from "@virgultum/core/store";

import type { SurfaceRefPlaceHolder } from "./components/placeholder.js";

const surfaceRefStyles = `
  myoxus-surface-ref {
    position: relative;
  }

  myoxus-surface-ref:not(:hover)
    myoxus-surface-ref-toolbar:not([data-open-menu-display="show"]) {
    display: none;
  }

  .myoxus-surface-ref {
    position: relative;
    user-select: none;
    margin: 10px 0;
    break-inside: avoid;
    border-radius: 8px;
    border: 1px solid var(--myoxus-border-color);
    background-color: var(--myoxus-background-primary-color);
    overflow: hidden;
  }

  .myoxus-surface-ref.focused {
    border-color: var(--myoxus-primary-color);
  }

  .myoxus-surface-ref.comment-highlighted {
    outline: 2px solid var(--myoxus-primary-color);
  }

  @media print {
    .myoxus-surface-ref {
      outline: none !important;
    }
  }

  .ref-content {
    position: relative;
    background-color: var(--myoxus-background-primary-color);
    background: radial-gradient(
      var(--myoxus-edgeless-grid-color) 1px,
      var(--myoxus-background-primary-color) 1px
    );
  }

  .ref-viewport {
    max-width: 100%;
    margin: 0 auto;
    position: relative;
    overflow: hidden;
    user-select: none;
  }

  .ref-viewport-event-mask {
    position: absolute;
    inset: 0;
  }
`;

@Peekable({
  enableOn: (block: SurfaceRefBlockComponent) => !!block.referenceModel,
})
export class SurfaceRefBlockComponent extends NativeBlockComponent<SurfaceRefBlockModel> {
  private readonly _previewDoc$ = signal<Store | null>(null);
  private readonly _referencedModel$ = signal<GfxModel | null>(null);
  private readonly _revision$ = signal(0);

  private _runtimePreviewExt: ExtensionType[] = [];

  hoverableContainer!: HTMLDivElement;
  captionElement!: BlockCaptionEditor;

  private get _viewExtensionManager() {
    return this.std.get(ViewExtensionManagerIdentifier);
  }

  private get _previewSpec() {
    return [
      ...this._viewExtensionManager.get("preview-edgeless"),
      ViewportElementExtension(".ref-viewport"),
    ];
  }

  // since the xywh of edgeless element is not a signal, we need to use a signal to store the xywh
  private readonly _referenceXYWH$ = signal<SerializedXYWH | null>(null);

  private get _shouldRender() {
    return (
      this.isConnected &&
      // prevent surface-ref from render itself in loop
      !this.parentComponent?.closest("myoxus-surface-ref")
    );
  }

  get referenceModel() {
    return this._referencedModel$.value;
  }

  get previewEditor(): EditorHost | null {
    return this.querySelector<EditorHost>("editor-host");
  }

  get isCommentHighlighted() {
    return (
      this.std
        .getOptional(BlockElementCommentManager)
        ?.isBlockCommentHighlighted(this.model) ?? false
    );
  }

  override requestUpdate() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  private readonly _handleClick = () => {
    this.selection.update(() => {
      return [this.selection.create(BlockSelection, { blockId: this.blockId })];
    });
  };

  private _initHotkey() {
    const selection = this.host.selection;
    const addParagraph = () => {
      if (!this.store.getParent(this.model)) return;

      const [paragraphId] = this.store.addSiblingBlocks(this.model, [
        {
          flavour: "myoxus:paragraph",
        },
      ]);
      const model = this.store.getModelById(paragraphId);
      if (!model) return;

      requestConnectedFrame(() => {
        selection.update((selList) => {
          return selList
            .filter<BaseSelection>((sel) => !sel.is(BlockSelection))
            .concat(
              selection.create(TextSelection, {
                from: {
                  blockId: model.id,
                  index: 0,
                  length: 0,
                },
                to: null,
              }),
            );
        });
      }, this);
    };

    this.bindHotKey({
      Enter: () => {
        if (!this.selected$.value) return;
        addParagraph();
        return true;
      },
    });
  }

  private _initReferencedModel() {
    let scopeId: string | undefined;
    let binding:
      ReturnType<NonNullable<DocEmbedProvider["openReference"]>> | undefined;
    let scope: ReturnType<NonNullable<DocEmbedProvider["inWorkspace"]>>;
    let loading: AbortController | undefined;
    let targetListeners = new DisposableGroup();
    const init = () => {
      loading?.abort();
      loading = undefined;
      targetListeners.dispose();
      targetListeners = new DisposableGroup();
      this._referencedModel$.value = null;
      this._previewDoc$.value = null;
      const { reference, workspaceId } = this.model.props;
      const rawDocId = this.model.props.pageId;
      const provider = this.std.getOptional(DocEmbedProvider);
      const identity = JSON.stringify([
        workspaceId ?? this.std.workspace.id,
        rawDocId,
      ]);
      if (scopeId !== identity) {
        binding?.dispose();
        scope?.dispose();
        scopeId = identity;
        binding = rawDocId
          ? provider?.openReference?.(
              workspaceId ?? this.std.workspace.id,
              rawDocId,
            )
          : undefined;
        scope =
          binding ||
          (!rawDocId &&
            (workspaceId === undefined ||
              workspaceId === this.std.workspace.id))
            ? undefined
            : provider?.inWorkspace?.(workspaceId ?? this.std.workspace.id);
      }
      const target = binding?.target.value;
      const pageId = target?.docId ?? rawDocId;
      const access = binding ? target?.access : (scope?.access ?? provider);
      // An element-only local reference keeps its containing snapshot's geometry.
      const localElement =
        !rawDocId &&
        (workspaceId === undefined || workspaceId === this.std.workspace.id);
      const collection = binding
        ? target?.collection
        : (scope?.collection ??
          (localElement || (workspaceId === undefined && !provider?.inWorkspace)
            ? this.std.workspace
            : undefined));
      const foreign = collection?.id !== this.std.workspace.id;
      if (!reference || !collection || (foreign && !pageId)) return;
      const find = () => {
        const candidates = pageId
          ? [collection.getDoc(pageId)]
          : [collection.getDoc(this.store.id), ...collection.docs.values()];
        for (const candidate of candidates) {
          if (
            !candidate ||
            (access && access.readable(candidate.id).value !== true)
          )
            continue;
          // `reference` is an element/block ID, never a document lookup key.
          const store = candidate.getStore({ readonly: true });
          const block = store.getBlock(reference)?.model;
          const element =
            block instanceof GfxBlockElementModel
              ? block
              : getSurfaceBlock(store)?.getElementById(reference);
          if (!element?.xywh) continue;
          this._referencedModel$.value = element;
          this._previewDoc$.value = store;
          this._referenceXYWH$.value = element.xywh;
          targetListeners.add(
            store.slots.blockUpdated.subscribe(({ id, type }) => {
              if (id === reference && type === "delete") init();
            }),
          );
          const surface = getSurfaceBlock(store);
          if (surface)
            targetListeners.add(
              surface.elementRemoved.subscribe(({ id }) => {
                if (id === reference) init();
              }),
            );
          this.requestUpdate();
          return;
        }
        this.requestUpdate();
      };
      find();
      if (
        pageId &&
        access &&
        access.readable(pageId).value === true &&
        !this._referencedModel$.peek()
      ) {
        const attempt = new AbortController();
        loading = attempt;
        void access
          .waitForLoaded(pageId, attempt.signal)
          .then(() => {
            if (
              !attempt.signal.aborted &&
              access.readable(pageId).value === true
            )
              find();
          })
          .catch(() => {
            if (!attempt.signal.aborted) this.requestUpdate();
          });
      }
    };
    this.disposables.add(effect(init));
    this.disposables.add(() => {
      loading?.abort();
      targetListeners.dispose();
      binding?.dispose();
      scope?.dispose();
      scopeId = undefined;
    });
    this.disposables.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (["reference", "pageId", "workspaceId"].includes(key)) init();
      }),
    );
    this.disposables.add(
      this.store.slots.blockUpdated.subscribe(({ type }) => {
        if (type === "delete") init();
      }),
    );
  }

  private _initViewport() {
    this._referenceXYWH$.value = this.referenceModel?.xywh ?? null;

    const refreshViewport = () => {
      if (!this._referenceXYWH$.value) return;
      const previewEditorHost = this.previewEditor;
      if (!previewEditorHost) return;
      const gfx = previewEditorHost.std.get(GfxControllerIdentifier);
      const viewport = gfx.viewport;

      viewport.setViewportByBound(
        Bound.deserialize(this._referenceXYWH$.value),
        this.referenceModel instanceof FrameBlockModel
          ? undefined
          : [20, 20, 20, 20],
      );
    };
    this.disposables.add(effect(refreshViewport));

    const referenceId = this.model.props.reference;
    const referenceXYWH$ = this._referenceXYWH$;
    class SurfaceRefViewportWatcher extends LifeCycleWatcher {
      static override readonly key = "surface-ref-viewport-watcher";

      private readonly _disposable = new DisposableGroup();

      override mounted() {
        const crud = this.std.get(EdgelessCRUDIdentifier);
        const gfx = this.std.get(GfxControllerIdentifier);
        const { surface, viewport } = gfx;
        if (!surface) return;

        const referenceElement = crud.getElementById(referenceId);
        if (!referenceElement) {
          throw new VirgultumError(
            ErrorCode.MissingViewModelError,
            `can not find element(id:${referenceElement})`,
          );
        }
        referenceXYWH$.value = referenceElement.xywh;

        const { _disposable } = this;
        refreshViewport();
        _disposable.add(viewport.sizeUpdated.subscribe(refreshViewport));

        if (referenceElement instanceof GfxBlockElementModel) {
          _disposable.add(
            referenceElement.xywh$.subscribe((xywh) => {
              referenceXYWH$.value = xywh;
            }),
          );
        } else if (referenceElement instanceof GfxPrimitiveElementModel) {
          _disposable.add(
            surface.elementUpdated.subscribe(({ id, oldValues }) => {
              if (
                id === referenceId &&
                oldValues.xywh !== referenceElement.xywh
              ) {
                referenceXYWH$.value = referenceElement.xywh;
              }
            }),
          );
        }

        const subscription = this.std.view.viewUpdated.subscribe(
          ({ id, type, method, view }) => {
            if (
              id === referenceElement.id &&
              type === "block" &&
              method === "add" &&
              view instanceof FrameBlockComponent
            ) {
              view.showBorder = false;
              subscription.unsubscribe();
            }
          },
        );
        _disposable.add(subscription);
      }

      override unmounted() {
        this._disposable.dispose();
      }
    }

    this._runtimePreviewExt = [SurfaceRefViewportWatcher];
  }

  private _initHover() {
    const { setReference, setFloating, dispose } = whenHover(
      (hovered) => {
        const message$ = this.std.get(ToolbarRegistryIdentifier).message$;
        if (hovered) {
          message$.value = {
            flavour: this.model.flavour,
            element: this,
            setFloating,
          };
          return;
        }

        // Clears previous bindings
        message$.value = null;
        setFloating();
      },
      { enterDelay: 500 },
    );
    setReference(this.hoverableContainer);
    this.disposables.add(dispose);
  }

  readonly open = ({
    openMode,
    event,
  }: {
    openMode?: OpenDocMode;
    event?: MouseEvent;
  } = {}) => {
    const pageId = this.referenceModel?.surface?.store.id;
    if (!pageId) return;

    this.std.getOptional(RefNodeSlotsProvider)?.docLinkClicked.next({
      pageId: pageId,
      workspaceId: this.model.props.workspaceId,
      params: {
        mode: "edgeless",
        elementIds: [this.model.props.reference],
      },
      openMode,
      event,
      host: this.host,
    });
  };

  connectedCallback() {
    if (!this.connectBlock()) return;
    installEditorStyles(this, surfaceRefStyles);

    this.contentEditable = "false";
    if (!this._shouldRender) return;

    const doc = this.ownerDocument;
    const refBox = doc.createElement("div");
    refBox.className = "myoxus-surface-ref";
    this.hoverableContainer = refBox;
    this.disposables.addFromEvent(refBox, "click", this._handleClick);

    const caption = doc.createElement(
      "block-caption-editor",
    ) as BlockCaptionEditor;
    caption.model = this.model as unknown as BlockCaptionEditor["model"];
    caption.std = this.std;
    this.captionElement = caption;

    this.replaceChildren(refBox, caption);
    this.mountBlockWidgets(this);

    this._initReferencedModel();
    this._initHotkey();
    this._initViewport();
    this._initHover();

    let placeholderEl: SurfaceRefPlaceHolder | null = null;
    let refContentEl: HTMLDivElement | null = null;
    let refViewportEl: HTMLDivElement | null = null;
    let maskEl: HTMLDivElement | null = null;
    let mountedPreviewDoc: Store | null = null;

    this.disposables.add(
      effect(() => {
        void this._revision$.value;
        const referencedModel = this._referencedModel$.value;
        const previewDoc = this._previewDoc$.value;
        const xywh = this._referenceXYWH$.value;
        const selected = this.selected$.value;
        const refFlavour = this.model.props.refFlavour$.value;
        const themeProvider = this.std.get(ThemeProvider);
        const theme = themeProvider.theme$.value;
        const edgelessTheme = themeProvider.edgeless$.value;

        untracked(() => {
          refBox.classList.toggle("focused", selected);
          refBox.classList.toggle(
            "comment-highlighted",
            this.isCommentHighlighted,
          );

          const isEmpty = !referencedModel || !referencedModel.xywh;
          if (isEmpty) {
            refContentEl = null;
            refViewportEl = null;
            maskEl = null;
            mountedPreviewDoc = null;
            if (!placeholderEl) {
              placeholderEl = doc.createElement(
                "surface-ref-placeholder",
              ) as SurfaceRefPlaceHolder;
              refBox.replaceChildren(placeholderEl);
            }
            placeholderEl.i18n =
              this.std.getOptional(EditorI18nProvider) ?? undefined;
            placeholderEl.referenceModel = referencedModel;
            placeholderEl.refFlavour = refFlavour;
            placeholderEl.theme = theme;
            return;
          }

          placeholderEl = null;
          if (!xywh) {
            refBox.replaceChildren();
            refContentEl = null;
            refViewportEl = null;
            maskEl = null;
            mountedPreviewDoc = null;
            return;
          }

          const { w, h } = Bound.deserialize(xywh);
          const aspectRatio = h !== 0 ? w / h : 1;

          if (!refContentEl || !refViewportEl || !maskEl) {
            refContentEl = doc.createElement("div");
            refContentEl.className = "ref-content";
            refViewportEl = doc.createElement("div");
            refViewportEl.className = "ref-viewport";
            maskEl = doc.createElement("div");
            maskEl.className = "ref-viewport-event-mask";
            refViewportEl.append(maskEl);
            refContentEl.append(refViewportEl);
            refBox.replaceChildren(refContentEl);
          }

          refViewportEl.style.aspectRatio = `${aspectRatio}`;
          refViewportEl.dataset.theme = edgelessTheme;

          if (mountedPreviewDoc !== previewDoc) {
            mountedPreviewDoc = previewDoc;
            if (previewDoc) {
              const previewHost = new BlockStdScope({
                store: previewDoc,
                extensions: this._previewSpec.concat(this._runtimePreviewExt),
              }).render();
              refViewportEl.replaceChildren(previewHost, maskEl);
            } else {
              refViewportEl.replaceChildren(maskEl);
            }
          }
        });
      }),
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.replaceChildren();
  }

  viewInEdgeless() {
    if (!this._referenceXYWH$.value) return;

    const viewport = {
      xywh: this._referenceXYWH$.value,
      padding: [20, 20, 20, 20] as [number, number, number, number],
    };

    this.std.get(EditPropsStore).setStorage("viewport", viewport);
    this.std.get(DocModeProvider).setEditorMode("edgeless");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-surface-ref": SurfaceRefBlockComponent;
  }
}
