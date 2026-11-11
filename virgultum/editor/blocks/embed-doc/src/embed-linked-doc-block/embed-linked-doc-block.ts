import { DisposableGroup } from "@virgultum/global/disposable";
import { effect, computed } from "@preact/signals-core";
import {
  EmbedBlockComponent,
  RENDER_CARD_THROTTLE_MS,
} from "@virgultum/block-embed";
import { SurfaceBlockModel } from "@virgultum/block-surface";
import { isPeekable, Peekable } from "@virgultum/components/peek";
import { Bound } from "@virgultum/global/gfx";
import { RefNodeSlotsProvider } from "@virgultum/inline-reference";
import type {
  DocMode,
  EmbedLinkedDocModel,
  EmbedLinkedDocStyles,
} from "@virgultum/model";
import {
  EMBED_CARD_HEIGHT,
  EMBED_CARD_WIDTH,
  REFERENCE_NODE,
} from "@virgultum/shared/consts";
import {
  CitationProvider,
  DocDisplayMetaProvider,
  DocDisplayMetaService,
  DocEmbedProvider,
  DocModeProvider,
  OpenDocExtensionIdentifier,
  type OpenDocMode,
  EditorChromeHostIdentifier,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import {
  cloneReferenceInfo,
  cloneReferenceInfoWithoutAliases,
  isNewTabTrigger,
  isNewViewTrigger,
  matchModels,
  referenceToNode,
} from "@virgultum/shared/utils";
import { BlockSelection } from "@virgultum/std";
import { Text } from "@virgultum/store";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import throttle from "lodash-es/throttle";
import { filter } from "rxjs/operators";
import * as Y from "yjs";

import { renderLinkedDocInCard } from "../common/render-linked-doc";
import { styles } from "./styles.js";

@Peekable({
  enableOn: ({ store }: EmbedLinkedDocBlockComponent) => !store.readonly,
})
export class EmbedLinkedDocBlockComponent extends EmbedBlockComponent<EmbedLinkedDocModel> {
  private _loadAttempt?: AbortController;
  private _targetListeners = new DisposableGroup();
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

  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = styles;

  private readonly _load = async () => {
    this._loadAttempt?.abort();
    const attempt = new AbortController();
    this._loadAttempt = attempt;
    // If this is a citation linked doc block, we don't need to load the linked doc and render linked doc content in card
    if (this.isCitation) {
      return;
    }

    const context = this.targetContext;
    const access = context?.access;
    if (context && access?.readable(context.docId).value === true) {
      this._loading = true;
      try {
        await access.waitForLoaded(
          context.docId,
          AbortSignal.any([attempt.signal, AbortSignal.timeout(30_000)]),
        );
      } catch (error) {
        if (attempt.signal.aborted) return;
        throw error;
      }
      if (attempt.signal.aborted) return;
      if (access.readable(context.docId).value !== true) {
        this.isError = true;
        this._loading = false;
        return;
      }
    }

    const {
      loading = true,
      isError = false,
      isBannerEmpty = true,
      isNoteContentEmpty = true,
    } = this.getInitialState();

    this._loading = loading;
    this.isError = isError;
    this.isBannerEmpty = isBannerEmpty;
    this.isNoteContentEmpty = isNoteContentEmpty;

    if (!this._loading) {
      return;
    }

    const linkedDoc = this.linkedDoc;
    if (!linkedDoc) {
      const context = this.targetContext;
      this._loading =
        (this._referenceBinding?.target.value === undefined &&
          !!this._referenceBinding) ||
        (context?.access?.readable(context.docId).value === undefined &&
          !!context?.access);
      return;
    }

    if (attempt.signal.aborted || linkedDoc !== this.linkedDoc) return;
    if (!linkedDoc.loaded) {
      try {
        linkedDoc.load();
      } catch (e) {
        console.error(e);
        this.isError = true;
      }
    }

    if (!this.isError && !linkedDoc.root) {
      this.isError = true;
    }
    if (attempt.signal.aborted || linkedDoc !== this.linkedDoc) return;

    this._loading = false;

    // If it is a link to a block or element, the content will not be rendered.
    if (this._referenceToNode) {
      return;
    }

    if (!this.isError) {
      const cardStyle = this.model.props.style;
      if (cardStyle === "horizontal" || cardStyle === "vertical") {
        renderLinkedDocInCard(this);
      }
    }
  };

  private readonly _selectBlock = () => {
    const selectionManager = this.std.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  };

  private readonly _setDocUpdatedAt = () => {
    const context = this.targetContext;
    const meta =
      context?.access?.readable(context.docId).value === true
        ? context.collection.meta.getDocMeta(context.docId)
        : undefined;
    const value = meta?.updatedDate || meta?.createDate;
    const date = value === undefined ? null : new Date(value);
    this._docUpdatedAt = date && !Number.isNaN(date.getTime()) ? date : null;
  };

  override _cardStyle: (typeof EmbedLinkedDocStyles)[number] = "horizontal";

  convertToEmbed = () => {
    if (this._referenceToNode) return;

    const { caption } = this.model.props;
    const { parent, store } = this.model;
    const index = parent?.children.indexOf(this.model);

    const blockId = store.addBlock(
      "myoxus:embed-synced-doc",
      {
        caption,
        ...cloneReferenceInfoWithoutAliases(this.referenceInfo$.peek()),
      },
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
    const parent = store.getParent(this.model);
    if (!parent) {
      return;
    }
    const index = parent.children.indexOf(this.model);

    const yText = new Y.Text();
    yText.insert(0, REFERENCE_NODE);
    yText.format(0, REFERENCE_NODE.length, {
      reference: {
        type: "LinkedPage",
        ...this.referenceInfo$.peek(),
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

  referenceInfo$ = computed(() => {
    const { pageId, workspaceId, params, title$, description$ } =
      this.model.props;
    const context = this.targetContext;
    return cloneReferenceInfo({
      pageId: context?.docId ?? pageId,
      workspaceId: context?.collection.id ?? workspaceId,
      params,
      title: title$.value,
      description: description$.value,
    });
  });

  icon$ = computed(() => {
    const { pageId, params, title } = this.referenceInfo$.value;
    const context = this.targetContext;
    if (
      !context ||
      (context.access && context.access.readable(pageId).value !== true)
    )
      return nothing;
    if (context.collection.id !== this.std.workspace.id)
      return DocDisplayMetaService.icons.linkedPage;
    return this.std
      .get(DocDisplayMetaProvider)
      .icon(pageId, { params, title, referenced: true }).value;
  });

  open = ({
    openMode,
    event,
  }: {
    openMode?: OpenDocMode;
    event?: MouseEvent;
  } = {}) => {
    if (this.targetContext?.access?.readable(this.targetDocId).value !== true)
      return;
    this.std.getOptional(RefNodeSlotsProvider)?.docLinkClicked.next({
      ...this.referenceInfo$.peek(),
      openMode,
      event,
      host: this.host,
    });
  };

  refreshData = () => {
    this._load().catch((e) => {
      console.error(e);
      this.isError = true;
    });
  };

  title$ = computed(() => {
    const { pageId, params, title } = this.referenceInfo$.value;
    const context = this.targetContext;
    if (
      !context ||
      (context.access && context.access.readable(pageId).value !== true)
    )
      return "";
    if (context.collection.id !== this.std.workspace.id)
      return context.access?.referenceTitleSignal?.(pageId)?.value ?? "";
    return (
      this.std
        .get(DocDisplayMetaProvider)
        .title(pageId, { params, title, referenced: true }).value || title
    );
  });

  get docTitle() {
    return (
      this.model.props.title ||
      this.linkedDoc?.meta?.title ||
      this._text(editorMessage("Untitled", "Untitled"))
    );
  }

  get editorMode() {
    return this._linkedDocMode;
  }

  get linkedDoc() {
    const context = this.targetContext;
    if (
      !context ||
      (context.access &&
        context.access.readable(this.targetDocId).value !== true)
    )
      return null;
    const doc = context.collection.getDoc(context.docId);
    return doc?.getStore({ id: context.docId, readonly: true });
  }

  get readonly() {
    return this.store.readonly;
  }

  get citationService() {
    return this.std.get(CitationProvider);
  }

  get isCitation() {
    return this.citationService.isCitationModel(this.model);
  }

  private readonly _handleDoubleClick = (event: MouseEvent) => {
    event.stopPropagation();
    const openDocService = this.std.get(OpenDocExtensionIdentifier);
    const shouldOpenInPeek =
      openDocService.isAllowed("open-in-center-peek") && isPeekable(this);
    this.open({
      openMode: shouldOpenInPeek
        ? "open-in-center-peek"
        : "open-in-active-view",
      event,
    });
  };

  private _isDocEmpty() {
    const linkedDoc = this.linkedDoc;
    if (!linkedDoc) {
      return false;
    }
    return !!linkedDoc && this.isNoteContentEmpty && this.isBannerEmpty;
  }

  protected _handleClick = (event: MouseEvent) => {
    if (isNewTabTrigger(event)) {
      this.open({ openMode: "open-in-new-tab", event });
    } else if (isNewViewTrigger(event)) {
      this.open({ openMode: "open-in-new-view", event });
    }

    if (this.readonly) {
      return;
    }
    this._selectBlock();
  };

  private readonly _renderCitationView = () => {
    const { footnoteIdentifier } = this.model.props;
    return html`<div
      draggable="${this.blockDraggable ? "true" : "false"}"
      class=${classMap({
        "embed-block-container": true,
        ...this.selectedStyle$?.value,
      })}
      style=${styleMap({
        ...this.embedContainerStyle,
      })}
    >
      <myoxus-citation-card
        .icon=${this.icon$.value}
        .citationTitle=${this.title$.value}
        .citationIdentifier=${footnoteIdentifier}
        .active=${this.selected$.value}
        .onClickCallback=${this._handleClick}
        .onDoubleClickCallback=${this._handleDoubleClick}
      ></myoxus-citation-card>
    </div> `;
  };

  // Keep preview identity stable across React commits and resource/alias updates.
  private readonly _noteElement = Object.assign(document.createElement("div"), {
    className: "myoxus-embed-linked-doc-content-note render",
  });

  private readonly _mountPreview = (container: HTMLDivElement | null) => {
    if (container && this._noteElement.parentElement !== container)
      container.replaceChildren(this._noteElement);
  };

  private readonly _renderEmbedView = () => {
    const linkedDoc = this.linkedDoc;
    const inSurface = matchModels(this.model.parent, [SurfaceBlockModel]);
    const updated =
      this.targetContext?.access?.readable(this.targetDocId).value === true
        ? this._docUpdatedAt
        : null;
    return this.renderEmbed(
      () =>
        html`<div
          class=${classMap({ "myoxus-embed-linked-doc-block": true, [this._cardStyle]: true })}
          @click=${this._handleClick}
          @dblclick=${this._handleDoubleClick}
        >
          ${this.std.get(EditorChromeHostIdentifier).renderDocumentCard({
            title: this.title$.value ?? "",
            description: this.model.props.description$.value ?? "",
            updated: updated
              ? this._cardStyle === "cube"
                ? updated.toLocaleTimeString(
                    this.std.getOptional(EditorI18nProvider)?.locale$.value,
                  )
                : updated.toLocaleString(
                    this.std.getOptional(EditorI18nProvider)?.locale$.value,
                  )
              : null,
            loading: this._loading,
            error: this.isError,
            unavailable: !!linkedDoc?.meta?.trash || !linkedDoc,
            deleted: !!linkedDoc?.meta?.trash,
            empty: this._isDocEmpty() && this.isBannerEmpty,
            nodeReference: this._referenceToNode,
            selected: this.selected$.value || this.isCommentHighlighted,
            inSurface,
            variant: this._cardStyle,
            height: this._cardHeight,
            width: this._cardWidth,
            mountPreview: this._mountPreview,
            reload: this.refreshData,
          })}
        </div>`,
      "native",
    );
  };

  private readonly _trackCitationDeleteEvent = () => {
    // Check citation delete event
    this._disposables.add(
      this.std.store.slots.blockUpdated
        .pipe(
          filter((payload) => {
            if (!payload.isLocal) return false;
            const { flavour, id, type } = payload;
            if (
              type !== "delete" ||
              flavour !== this.model.flavour ||
              id !== this.model.id
            )
              return false;
            const { model } = payload;
            if (!this.citationService.isCitationModel(model)) return false;
            return true;
          }),
        )
        .subscribe(() => {
          this.citationService.trackEvent("Delete");
        }),
    );
  };

  override connectedCallback() {
    super.connectedCallback();

    this._cardStyle = this.model.props.style;
    this._referenceToNode = referenceToNode(this.model.props);

    this.disposables.add(() => {
      this._loadAttempt?.abort();
      this._targetListeners.dispose();
      this._referenceBinding?.dispose();
      this._referenceIdentity = undefined;
      this._referenceScope?.dispose();
      this._referenceScope = undefined;
    });

    const bindTarget = () => {
      this._targetListeners.dispose();
      this._targetListeners = new DisposableGroup();
      const linkedDoc = this.linkedDoc;
      if (linkedDoc) {
        // Should throttle the blockUpdated event to avoid too many re-renders
        // Because the blockUpdated event is triggered too frequently at some cases
        this._targetListeners.add(
          linkedDoc.slots.blockUpdated.subscribe(
            throttle((payload) => {
              if (
                payload.type === "update" &&
                ["", "caption", "xywh"].includes(payload.props.key)
              ) {
                return;
              }

              if (payload.type === "add" && payload.init) {
                return;
              }

              this._load().catch((e) => {
                console.error(e);
                this.isError = true;
              });
            }, RENDER_CARD_THROTTLE_MS),
          ),
        );

        this._setDocUpdatedAt();
        const collection = this.targetContext?.collection;
        if (collection)
          this._targetListeners.add(
            collection.slots.docListUpdated.subscribe(() => {
              this._setDocUpdatedAt();
              this.refreshData();
            }),
          );

        if (this._referenceToNode) {
          this._linkedDocMode = this.model.props.params?.mode ?? "page";
        } else {
          const docMode = this.std.get(DocModeProvider);
          if (this.targetContext?.collection.id !== this.std.workspace.id) {
            const primaryMode = this.targetContext?.access?.primaryMode?.(
              this.targetDocId,
            );
            this._targetListeners.add(
              effect(() => {
                this._linkedDocMode = primaryMode?.value ?? "page";
              }),
            );
          } else {
            this._linkedDocMode = docMode.getPrimaryMode(this.targetDocId);
            this._targetListeners.add(
              docMode.onPrimaryModeChange((mode) => {
                this._linkedDocMode = mode;
              }, this.targetDocId),
            );
          }
        }
      }
    };
    this.disposables.add(
      effect(() => {
        void this.targetContext?.access?.readable(this.targetDocId).value;
        bindTarget();
        this.refreshData();
      }),
    );

    this.disposables.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (key === "style") {
          this._cardStyle = this.model.props.style;
        }
        if (["pageId", "workspaceId", "params"].includes(key)) {
          this._referenceToNode = referenceToNode(this.model.props);
          bindTarget();
        }
        if (key === "pageId" || key === "workspaceId" || key === "style") {
          this._load().catch((e) => {
            console.error(e);
            this.isError = true;
          });
        }
      }),
    );

    this._trackCitationDeleteEvent();
  }

  getInitialState(): {
    loading?: boolean;
    isError?: boolean;
    isNoteContentEmpty?: boolean;
    isBannerEmpty?: boolean;
  } {
    return {};
  }

  override renderBlock() {
    return this.isCitation
      ? this._renderCitationView()
      : this._renderEmbedView();
  }

  override updated() {
    if (this.readonly || this._loading) {
      return;
    }
    // update card style when linked doc deleted
    const linkedDoc = this.linkedDoc;
    const { xywh, style } = this.model.props;
    const bound = Bound.deserialize(xywh);
    if (linkedDoc && style === "horizontalThin") {
      bound.w = EMBED_CARD_WIDTH.horizontal;
      bound.h = EMBED_CARD_HEIGHT.horizontal;
      this.store.withoutTransact(() => {
        this.store.updateBlock(this.model, {
          xywh: bound.serialize(),
          style: "horizontal",
        });
      });
    } else if (!linkedDoc && style === "horizontal") {
      bound.w = EMBED_CARD_WIDTH.horizontalThin;
      bound.h = EMBED_CARD_HEIGHT.horizontalThin;
      this.store.withoutTransact(() => {
        this.store.updateBlock(this.model, {
          xywh: bound.serialize(),
          style: "horizontalThin",
        });
      });
    }
  }

  @state()
  private accessor _docUpdatedAt: Date | null = null;

  @state()
  private accessor _linkedDocMode: DocMode = "page";

  @state()
  private accessor _loading = false;

  // reference to block/element
  @state()
  private accessor _referenceToNode = false;

  @property({ attribute: false })
  accessor isBannerEmpty = false;

  @property({ attribute: false })
  accessor isError = false;

  @property({ attribute: false })
  accessor isNoteContentEmpty = false;

  get noteContainer(): Promise<HTMLDivElement | null> {
    return this.updateComplete.then(() => this._noteElement);
  }
}
