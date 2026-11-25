import { computed, effect, signal, untracked } from "@preact/signals-core";
import { SurfaceBlockModel } from "@virgultum/canvas-runtime/surface";
import {
  NativeCaptionedBlockComponent,
  SelectedStyle,
} from "@virgultum/content/caption";
import {
  ErrorCode,
  VirgultumError,
} from "@virgultum/core/primitives/exceptions";
import type { EmbedIframeBlockModel } from "@virgultum/core/models";
import {
  type EmbedIframeData,
  EmbedIframeService,
  type IframeOptions,
  LinkPreviewServiceIdentifier,
  NotificationProvider,
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { matchModels } from "@virgultum/core/utils";
import { BlockSelection } from "@virgultum/core/runtime";

import type { IframeStatusCard } from "./components/iframe-status-card.js";
import {
  openIframeLinkEditor,
  type EmbedLinkInputPopupOptions,
} from "./components/iframe-link-session.js";
import {
  DEFAULT_IFRAME_HEIGHT,
  DEFAULT_IFRAME_WIDTH,
  EMBED_IFRAME_DEFAULT_CONTAINER_BORDER_RADIUS,
} from "./consts.js";
import { embedIframeBlockStyles } from "./style.js";
import { iframeSandbox, safeGetIframeSrc } from "./utils.js";

export type EmbedIframeStatus = "idle" | "loading" | "success" | "error";

export class EmbedIframeBlockComponent extends NativeCaptionedBlockComponent<EmbedIframeBlockModel> {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  protected override blockStyles = embedIframeBlockStyles;
  protected override useCaptionEditor = true;
  protected override useZeroWidth = true;

  protected showEditorSelection = true;

  blockDraggable = true;

  readonly status$ = signal<EmbedIframeStatus>("idle");
  readonly error$ = signal<Error | null>(null);

  readonly isIdle$ = computed(() => this.status$.value === "idle");
  readonly isLoading$ = computed(() => this.status$.value === "loading");
  readonly hasError$ = computed(() => this.status$.value === "error");
  readonly isSuccess$ = computed(() => this.status$.value === "success");

  readonly isDraggingOnHost$ = signal(false);
  readonly isResizing$ = signal(false);
  // show overlay to prevent the iframe from capturing pointer events
  // when the block is dragging, resizing, or not selected
  readonly showOverlay$ = computed(
    () =>
      this.isSuccess$.value &&
      (this.isDraggingOnHost$.value ||
        this.isResizing$.value ||
        !this.selected$.value),
  );

  // since different providers have different border radius
  // we need to update the selected border radius when the iframe is loaded
  readonly selectedBorderRadius$ = computed(() => {
    if (
      this.status$.value === "success" &&
      typeof this.iframeOptions?.containerBorderRadius === "number"
    ) {
      return this.iframeOptions.containerBorderRadius;
    }
    return EMBED_IFRAME_DEFAULT_CONTAINER_BORDER_RADIUS;
  });

  protected iframeOptions: IframeOptions | undefined = undefined;
  protected _edgelessWrapper: HTMLDivElement | null = null;
  _blockContainer: HTMLElement | null = null;

  constructor() {
    super();
    this.selectedStyle$.value = SelectedStyle.Border;
    this.blockContainerStyles$.value = {
      margin: "18px 0",
      backgroundColor: "transparent",
    };
  }

  get embedIframeService() {
    return this.std.get(EmbedIframeService);
  }

  get linkPreviewService() {
    return this.std.get(LinkPreviewServiceIdentifier);
  }

  get notificationService() {
    return this.std.getOptional(NotificationProvider);
  }

  get inSurface() {
    return matchModels(this.model.parent, [SurfaceBlockModel]);
  }

  open = () => {
    const link = this.model.props.url;
    if (!link) {
      this.notificationService?.notify({
        title: this._text(
          editorMessage("com.myoxus.editor.embed.no-link", "No link found"),
        ),
        message: this._text(
          editorMessage(
            "com.myoxus.editor.embed.set-link",
            "Please set a link for this block",
          ),
        ),
        accent: "warning",
        onClose: function (): void {},
      });
      return;
    }
    window.open(link, "_blank");
  };

  refreshData = async () => {
    try {
      const { url } = this.model.props;
      if (!url) {
        this.status$.value = "idle";
        return false;
      }

      this.status$.value = "loading";
      this.error$.value = null;

      const embedIframeService = this.embedIframeService;
      const linkPreviewService = this.linkPreviewService;
      if (!embedIframeService || !linkPreviewService) {
        throw new VirgultumError(
          ErrorCode.ValueNotExists,
          "EmbedIframeService or LinkPreviewService not found",
        );
      }

      const [embedData, previewData] = await Promise.all([
        embedIframeService.getEmbedIframeData(url),
        linkPreviewService.query(url),
      ]);

      const currentIframeUrl = this.model.props.iframeUrl;
      if (!embedData && !currentIframeUrl) {
        throw new VirgultumError(
          ErrorCode.ValueNotExists,
          "Failed to get embed data",
        );
      }

      const iframeUrl = this._getIframeUrl(embedData) ?? currentIframeUrl;
      this.store.updateBlock(this.model, {
        iframeUrl,
        title: embedData?.title || previewData?.title,
        description: embedData?.description || previewData?.description,
      });

      this._updateIframeOptions(url);
      this.status$.value = "success";
      return true;
    } catch (err) {
      this.status$.value = "error";
      this.error$.value = err instanceof Error ? err : new Error(String(err));
      console.error("Failed to refresh iframe data:", err);
      return false;
    }
  };

  private _linkInputAbortController: AbortController | null = null;
  /** Continue the Page form on the mounted command owner, including an error
   * whose status card has not finished its first asynchronous refresh. */
  resumeLinkInput() {
    if (!this._blockContainer || !this.isConnected || this.readonly) return;
    if (!this.model.props.url) {
      this.toggleLinkInputPopup();
      return;
    }
    this._linkInputAbortController?.abort();
    this._linkInputAbortController = new AbortController();
    openIframeLinkEditor(
      this.std,
      this.model,
      this._blockContainer,
      this._linkInputAbortController,
      this.inSurface,
      true,
    );
  }
  toggleLinkInputPopup = (options?: EmbedLinkInputPopupOptions) => {
    if (this.readonly) {
      return;
    }

    if (!this._blockContainer || !this.isIdle$.value || this.model.props.url) {
      return;
    }

    if (this._linkInputAbortController) {
      this._linkInputAbortController.abort();
    }

    this._linkInputAbortController = new AbortController();
    openIframeLinkEditor(
      this.std,
      this.model,
      this._blockContainer,
      this._linkInputAbortController,
      this.inSurface,
      false,
      options,
    );
  };

  private readonly _getIframeUrl = (embedData: EmbedIframeData | null) => {
    const { iframe_url, html } = embedData ?? {};
    return iframe_url ?? (html && safeGetIframeSrc(html));
  };

  private readonly _updateIframeOptions = (url: string) => {
    const config = this.embedIframeService?.getConfig(url);
    this.iframeOptions = config ? config.options : undefined;
  };

  private readonly _handleDoubleClick = () => {
    this.open();
  };

  private readonly _selectBlock = () => {
    const { selectionManager } = this;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup("note", [blockSelection]);
  };

  protected _handleClick = () => {
    if (this.isIdle$.value && !this.model.props.url) {
      this.selectionManager.clear([this.inSurface ? "surface" : "block"]);
      this.toggleLinkInputPopup();
      return;
    }

    if (this.inSurface) {
      return;
    }

    this._selectBlock();
  };

  private readonly _handleRetry = async () => {
    return await this.refreshData();
  };

  private readonly _getSourceHost = () => {
    const url = this.model.props.url ?? this.model.props.iframeUrl;
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return null;
    }
  };

  protected wrapContentHost(container: HTMLElement): HTMLElement {
    return container;
  }

  protected override mountBlock(container: HTMLElement) {
    this.contentEditable = "false";

    this.disposables.add(
      effect(() => {
        if (this.inSurface) {
          return;
        }
        this.selectedStyle =
          this.status$.value === "idle"
            ? SelectedStyle.Background
            : SelectedStyle.Border;
      }),
    );

    if (!this.model.props.iframeUrl) {
      this.store.withoutTransact(() => {
        this.refreshData().catch(console.error);
      });
    } else {
      this._updateIframeOptions(this.model.props.url);
      this.status$.value = "success";
    }

    this.disposables.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (key === "url") {
          this.refreshData().catch(console.error);
        }
      }),
    );

    this.handleEvent(
      "dragStart",
      () => {
        this.isDraggingOnHost$.value = true;
      },
      { global: true },
    );
    this.handleEvent(
      "dragEnd",
      () => {
        this.isDraggingOnHost$.value = false;
      },
      { global: true },
    );

    const doc = this.ownerDocument;
    const blockContainer = doc.createElement("div");
    blockContainer.className = "myoxus-embed-iframe-block-container";
    blockContainer.setAttribute(
      "draggable",
      this.blockDraggable ? "true" : "false",
    );
    this._blockContainer = blockContainer;

    const contentSlot = doc.createElement("div");
    contentSlot.style.display = "contents";
    const overlay = doc.createElement("div");
    overlay.className = "myoxus-embed-iframe-block-overlay";
    blockContainer.append(contentSlot, overlay);

    const hostTarget = this.wrapContentHost(container);
    hostTarget.replaceChildren(blockContainer);

    this.disposables.addFromEvent(blockContainer, "click", this._handleClick);
    this.disposables.addFromEvent(
      blockContainer,
      "dblclick",
      this._handleDoubleClick,
    );

    this.disposables.add(
      effect(() => {
        blockContainer.classList.toggle(
          "selected-style",
          this.showEditorSelection &&
            this.selected$.value &&
            this.isSuccess$.value,
        );
        blockContainer.classList.toggle("in-surface", this.inSurface);
        blockContainer.style.borderRadius = `${this.selectedBorderRadius$.value}px`;
        overlay.classList.toggle("show", this.showOverlay$.value);
      }),
    );

    let statusCard: IframeStatusCard | null = null;
    this.disposables.add(
      effect(() => {
        const isSuccess = this.isSuccess$.value;
        void this.revision$.value;
        const iframeUrl = this.model.props.iframeUrl;
        const url = this.model.props.url;

        untracked(() => {
          if (!isSuccess) {
            if (!statusCard) {
              statusCard = doc.createElement(
                "myoxus-embed-iframe-status-card",
              ) as IframeStatusCard;
              statusCard.std = this.std;
              statusCard.model = this.model;
              statusCard.onRetry = this._handleRetry;
              contentSlot.replaceChildren(statusCard);
            }
            return;
          }

          statusCard = null;
          const {
            widthPercent,
            heightInNote,
            style,
            allow,
            referrerpolicy,
            scrolling,
            allowFullscreen,
          } = this.iframeOptions ?? {};
          const width =
            widthPercent !== undefined
              ? `${widthPercent}%`
              : String(DEFAULT_IFRAME_WIDTH);
          const height = this.inSurface
            ? "100%"
            : String(heightInNote ?? DEFAULT_IFRAME_HEIGHT);
          const sandboxValue = iframeSandbox(
            this.embedIframeService.getConfig(url),
          );
          const sourceHost = this._getSourceHost();

          const iframe = doc.createElement("iframe");
          iframe.setAttribute("width", width);
          iframe.setAttribute("height", height);
          if (allowFullscreen) iframe.allowFullscreen = true;
          iframe.loading = "lazy";
          iframe.setAttribute("frameborder", "0");
          iframe.setAttribute("credentialless", "");
          iframe.setAttribute("sandbox", sandboxValue);
          if (iframeUrl !== undefined) iframe.setAttribute("src", iframeUrl);
          if (allow !== undefined) iframe.setAttribute("allow", allow);
          if (referrerpolicy !== undefined)
            iframe.setAttribute("referrerpolicy", referrerpolicy);
          if (scrolling !== undefined)
            iframe.setAttribute("scrolling", String(scrolling));
          if (style !== undefined) iframe.setAttribute("style", style);

          if (sourceHost) {
            const sourceEl = doc.createElement("div");
            sourceEl.className = "myoxus-embed-iframe-source";
            sourceEl.textContent = sourceHost;
            contentSlot.replaceChildren(iframe, sourceEl);
          } else {
            contentSlot.replaceChildren(iframe);
          }
        });
      }),
    );

    this.disposables.add(
      effect(() => {
        if (!statusCard) return;
        statusCard.status = this.status$.value as "idle" | "loading" | "error";
        statusCard.error = this.error$.value;
        statusCard.inSurface = this.inSurface;
        statusCard.selected = this.selected$.value;
      }),
    );
  }

  override disconnectedCallback() {
    this._linkInputAbortController?.abort();
    this._linkInputAbortController = null;
    this._blockContainer = null;
    this._edgelessWrapper = null;
    super.disconnectedCallback();
  }

  get readonly() {
    return this.store.readonly;
  }

  get selectionManager() {
    return this.host.selection;
  }
}
