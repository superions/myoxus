import { computed, effect, signal } from "@preact/signals-core";
import {
  NativeCaptionedBlockComponent,
  SelectedStyle,
  type BlockStyleMap,
} from "@virgultum/content/caption";
import type {
  BookmarkBlockModel,
  LinkPreviewData,
} from "@virgultum/core/models";
import { ImageProxyService } from "@virgultum/core/adapters";
import {
  BlockElementCommentManager,
  CitationProvider,
  DocModeProvider,
  EditorChromeHostIdentifier,
  type EditorBookmarkCardControls,
  LinkPreviewServiceIdentifier,
} from "@virgultum/core/services";
import { normalizeUrl } from "@virgultum/core/utils";
import { BlockSelection, isGfxBlockComponent } from "@virgultum/core/runtime";
import { filter } from "rxjs/operators";

import { refreshBookmarkUrlData } from "./utils.js";

export const BOOKMARK_MIN_WIDTH = 450;

export class BookmarkBlockComponent extends NativeCaptionedBlockComponent<BookmarkBlockModel> {
  protected override useCaptionEditor = true;
  protected override useZeroWidth = true;

  protected showEditorSelection = true;

  private _fetchAbortController?: AbortController;

  blockDraggable = true;

  protected readonly containerStyle$ = signal<BlockStyleMap>({
    position: "relative",
    width: "100%",
  });

  private readonly _error$ = signal(false);
  private readonly _loading$ = signal(false);

  get error() {
    return this._error$.value;
  }
  set error(value: boolean) {
    this._error$.value = value;
  }

  get loading() {
    return this._loading$.value;
  }
  set loading(value: boolean) {
    this._loading$.value = value;
  }

  /**
   * @description Local link preview data
   * When the doc is in readonly mode, and the link preview data are not provided (stored in the block model),
   * We will use the local link preview data fetched from the link previewer service to render the block.
   */
  private readonly _localLinkPreview$ = signal<LinkPreviewData>({
    icon: null,
    title: null,
    description: null,
    image: null,
  });

  /**
   * @description Link preview data for actual rendering
   * When the doc is not in readonly mode, and the link preview data are provided (stored in the block model),
   * We will use the model props to render the block.
   * Otherwise, we will use the local link preview data to render the block.
   */
  linkPreview$ = computed(() => {
    const modelProps = this.model.props;
    const local = this._localLinkPreview$.value;
    return {
      icon: modelProps.icon$.value ?? local.icon ?? null,
      title: modelProps.title$.value ?? local.title ?? null,
      description: modelProps.description$.value ?? local.description ?? null,
      image: modelProps.image$.value ?? local.image ?? null,
    };
  });

  private readonly _updateLocalLinkPreview = () => {
    // cancel any inflight request
    this._fetchAbortController?.abort();
    this._fetchAbortController = new AbortController();

    this.loading = true;
    this.error = false;

    this.std
      .get(LinkPreviewServiceIdentifier)
      .query(this.model.props.url, this._fetchAbortController.signal)
      .then((data) => {
        this._localLinkPreview$.value = {
          icon: data.icon ?? null,
          title: data.title ?? null,
          description: data.description ?? null,
          image: data.image ?? null,
        };
      })
      .catch(() => {
        this.error = true;
      })
      .finally(() => {
        this.loading = false;
      });
  };

  selectBlock = () => {
    const selectionManager = this.std.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  };

  get link() {
    return normalizeUrl(this.model.props.url);
  }

  open = () => {
    const link = this.link;
    if (!link) return;
    window.open(link, "_blank", "noopener,noreferrer");
  };

  refreshData = () => {
    refreshBookmarkUrlData(this, this._fetchAbortController?.signal).catch(
      console.error,
    );
  };

  get citationService() {
    return this.std.get(CitationProvider);
  }

  get isCitation() {
    return this.citationService.isCitationModel(this.model);
  }

  get imageProxyService() {
    return this.std.get(ImageProxyService);
  }

  get isCommentHighlighted() {
    return (
      this.std
        .getOptional(BlockElementCommentManager)
        ?.isBlockCommentHighlighted(this.model) ?? false
    );
  }

  handleClick = (event: MouseEvent) => {
    event.stopPropagation();

    if (
      this.model.parent?.flavour !== "myoxus:surface" &&
      !this.store.readonly
    ) {
      this.selectBlock();
    }
  };

  handleDoubleClick = (event: MouseEvent) => {
    event.stopPropagation();
    this.open();
  };

  constructor() {
    super();
    this.selectedStyle$.value = SelectedStyle.Border;
    this.blockContainerStyles$.value = { margin: "18px 0" };
  }

  private buildCardControls(): EditorBookmarkCardControls {
    void this.revision$.value;
    const preview = this.linkPreview$.value;
    const style = this.model.props.style$.value;
    const { url, footnoteIdentifier } = this.model.props;
    const citation = this.isCitation;
    return {
      citationIdentifier: citation
        ? (footnoteIdentifier ?? undefined)
        : undefined,
      inSurface: isGfxBlockComponent(this),
      selected: this.selected$.value,
      commentHighlighted: this.isCommentHighlighted,
      style: citation
        ? "list"
        : style === "vertical" || style === "list" || style === "cube"
          ? style
          : "horizontal",
      url,
      title: citation ? preview.title || url : preview.title,
      description: preview.description,
      icon: preview.icon ? this.imageProxyService.buildUrl(preview.icon) : null,
      image:
        !citation && preview.image
          ? this.imageProxyService.buildUrl(preview.image)
          : null,
      loading: citation ? false : this.loading,
      error: citation ? false : this.error,
      open: () => this.open(),
      select: () => {
        if (
          this.model.parent?.flavour !== "myoxus:surface" &&
          !this.store.readonly
        ) {
          this.selectBlock();
        }
      },
    };
  }

  private readonly _trackCitationDeleteEvent = () => {
    this.disposables.add(
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

  protected override mountBlock(container: HTMLElement) {
    const mode = this.std.get(DocModeProvider).getEditorMode();
    this.containerStyle$.value = {
      position: "relative",
      width: "100%",
      ...(mode === "edgeless" ? { minWidth: `${BOOKMARK_MIN_WIDTH}px` } : {}),
    };

    this._fetchAbortController = new AbortController();
    this.contentEditable = "false";

    const doc = this.ownerDocument;
    const wrapper = doc.createElement("div");
    wrapper.className = "myoxus-bookmark-container";
    wrapper.setAttribute("draggable", this.blockDraggable ? "true" : "false");
    container.replaceChildren(wrapper);

    if (this.isCitation) {
      this.disposables.addFromEvent(wrapper, "click", this.handleClick);
      this.disposables.addFromEvent(
        wrapper,
        "dblclick",
        this.handleDoubleClick,
      );
    }

    let appliedKeys: string[] = [];
    this.disposables.add(
      effect(() => {
        wrapper.classList.toggle(
          "selected-style",
          this.showEditorSelection && this.selected$.value,
        );
        const style = this.containerStyle$.value;
        for (const key of appliedKeys) {
          if (style[key] === undefined) {
            wrapper.style.setProperty(
              key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
              "",
            );
          }
        }
        appliedKeys = [];
        for (const [key, value] of Object.entries(style)) {
          if (value !== undefined) {
            (wrapper.style as unknown as Record<string, string>)[key] = value;
            appliedKeys.push(key);
          }
        }
      }),
    );

    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (chrome) {
      const state = computed(() => this.buildCardControls());
      this.disposables.add(chrome.mountBookmarkCard(wrapper, state));
    }

    if (
      (!this.model.props.description && !this.model.props.title) ||
      (!this.model.props.image && this.model.props.style === "vertical")
    ) {
      if (this.store.readonly) {
        this._updateLocalLinkPreview();
        return;
      }
      this.refreshData();
    }

    this.disposables.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (key === "url") {
          this.refreshData();
        }
      }),
    );

    this._trackCitationDeleteEvent();
  }

  override disconnectedCallback(): void {
    this._fetchAbortController?.abort();
    super.disconnectedCallback();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-bookmark": BookmarkBlockComponent;
  }
}
