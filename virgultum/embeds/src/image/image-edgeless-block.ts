import {
  EditorI18nProvider,
  EditorChromeHostIdentifier,
  type EditorAttachmentCardControls,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { computed, effect, signal, untracked } from "@preact/signals-core";
import { NativeGfxBlockComponent } from "@virgultum/canvas-runtime/surface";
import type { BlockCaptionEditor } from "@virgultum/content/caption";
import { Peekable } from "@virgultum/core/view/peek";
import { ResourceController } from "@virgultum/core/resource";
import { type ImageBlockModel, ImageBlockSchema } from "@virgultum/core/models";
import { cssVar } from "@virgultum/core/theme";
import { formatSize } from "@virgultum/core/utils";
import { installEditorStyles } from "@virgultum/core/runtime";
import { GfxViewInteractionExtension } from "@virgultum/core/runtime/gfx";

import type { ImageBlockFallbackCard } from "./components/image-fallback";
import {
  createImageLoadingSpinner,
  imageSelectedRectStyles,
} from "./components/image-selected-rect";
import {
  copyImageBlob,
  downloadImageBlob,
  refreshData,
  turnImageIntoCardView,
} from "./utils";

const edgelessImageStyles = `
  myoxus-edgeless-image {
    position: relative;
  }

  myoxus-edgeless-image .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 4px;
    right: 4px;
    width: 36px;
    height: 36px;
    padding: 5px;
    border-radius: 8px;
    background: var(--myoxus-black-10);
  }

  myoxus-edgeless-image .loading > svg {
    font-size: 25.71px;
  }

  myoxus-edgeless-image .myoxus-image-status {
    position: absolute;
    left: 18px;
    bottom: 18px;
  }

  myoxus-edgeless-image .resizable-img,
  myoxus-edgeless-image .resizable-img img {
    width: 100%;
    height: 100%;
  }

  myoxus-edgeless-image .resizable-img {
    position: relative;
    overflow: hidden;
  }
`;

@Peekable()
export class ImageEdgelessBlockComponent extends NativeGfxBlockComponent<ImageBlockModel> {
  private static readonly LOD_MIN_IMAGE_BYTES = 1024 * 1024;
  private static readonly LOD_MIN_IMAGE_PIXELS = 1920 * 1080;
  private static readonly LOD_MAX_ZOOM = 0.4;
  private static readonly LOD_THUMBNAIL_MAX_EDGE = 256;

  resourceController = new ResourceController(
    computed(() => this.model.props.sourceId$.value),
    "Image",
  );

  private _lodThumbnailUrl: string | null = null;
  private _lodSourceUrl: string | null = null;
  private _lodGeneratingSourceUrl: string | null = null;
  private _lodGenerationToken = 0;
  private _lastShouldUseLod = false;
  private readonly _lodRevision$ = signal(0);

  captionEditor: BlockCaptionEditor | null = null;
  resizableImg!: HTMLDivElement;

  private _containerEl: HTMLDivElement | null = null;
  private _contentSlotEl: HTMLDivElement | null = null;
  private _imgEl: HTMLImageElement | null = null;
  private _loadingEl: HTMLDivElement | null = null;
  private _statusEl: HTMLSpanElement | null = null;
  private _fallbackCardEl: ImageBlockFallbackCard | null = null;
  private _showingImage = false;

  get blobUrl() {
    return this.resourceController.blobUrl$.value;
  }

  convertToCardView = () => {
    turnImageIntoCardView(this).catch(console.error);
  };

  copy = () => {
    copyImageBlob(this).catch(console.error);
  };

  download = () => {
    downloadImageBlob(this).catch(console.error);
  };

  refreshData = () => {
    refreshData(this).catch(console.error);
  };

  private readonly _handleError = () => {
    this.resourceController.updateState({
      errorMessage: "Failed to download image!",
    });
  };

  private _isLargeImage() {
    const { width = 0, height = 0, size = 0 } = this.model.props;
    const pixels = width * height;
    return (
      size >= ImageEdgelessBlockComponent.LOD_MIN_IMAGE_BYTES ||
      pixels >= ImageEdgelessBlockComponent.LOD_MIN_IMAGE_PIXELS
    );
  }

  private _shouldUseLod(blobUrl: string | null, zoom = this.gfx.viewport.zoom) {
    return (
      Boolean(blobUrl) &&
      this._isLargeImage() &&
      zoom <= ImageEdgelessBlockComponent.LOD_MAX_ZOOM
    );
  }

  private _revokeLodThumbnail() {
    if (!this._lodThumbnailUrl) {
      return;
    }

    URL.revokeObjectURL(this._lodThumbnailUrl);
    this._lodThumbnailUrl = null;
  }

  private _resetLodSource(blobUrl: string | null) {
    if (this._lodSourceUrl === blobUrl) {
      return;
    }

    this._lodGenerationToken += 1;
    this._lodGeneratingSourceUrl = null;
    this._lodSourceUrl = blobUrl;
    this._revokeLodThumbnail();
  }

  private _createImageElement(src: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to load image"));
      image.src = src;
    });
  }

  private _createThumbnailBlob(image: HTMLImageElement) {
    const maxEdge = ImageEdgelessBlockComponent.LOD_THUMBNAIL_MAX_EDGE;
    const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = longestEdge > maxEdge ? maxEdge / longestEdge : 1;
    const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return Promise.resolve<Blob | null>(null);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve);
    });
  }

  private _ensureLodThumbnail(blobUrl: string) {
    if (
      this._lodThumbnailUrl ||
      this._lodGeneratingSourceUrl === blobUrl ||
      !this._shouldUseLod(blobUrl)
    ) {
      return;
    }

    const token = ++this._lodGenerationToken;
    this._lodGeneratingSourceUrl = blobUrl;

    void this._createImageElement(blobUrl)
      .then((image) => this._createThumbnailBlob(image))
      .then((blob) => {
        if (!blob || token !== this._lodGenerationToken || !this.isConnected) {
          return;
        }

        const thumbnailUrl = URL.createObjectURL(blob);
        if (token !== this._lodGenerationToken || !this.isConnected) {
          URL.revokeObjectURL(thumbnailUrl);
          return;
        }

        this._revokeLodThumbnail();
        this._lodThumbnailUrl = thumbnailUrl;

        if (this._shouldUseLod(this.blobUrl)) {
          this._lodRevision$.value++;
        }
      })
      .catch((err) => {
        if (token !== this._lodGenerationToken || !this.isConnected) {
          return;
        }
        console.error(err);
      })
      .finally(() => {
        if (token === this._lodGenerationToken) {
          this._lodGeneratingSourceUrl = null;
        }
      });
  }

  private _updateLodFromViewport(zoom: number) {
    const shouldUseLod = this._shouldUseLod(this.blobUrl, zoom);
    if (shouldUseLod === this._lastShouldUseLod) {
      return;
    }

    this._lastShouldUseLod = shouldUseLod;
    if (shouldUseLod && this.blobUrl) {
      this._ensureLodThumbnail(this.blobUrl);
    }
    this._lodRevision$.value++;
  }

  private _buildStatusControls(): EditorAttachmentCardControls | null {
    if (!this.blobUrl) return null;
    const { size = 0 } = this.model.props;
    const resolvedState = this.resourceController.resolveStateWith({
      title: "Image",
      description: formatSize(size),
    });
    const { description, error, needUpload } = resolvedState;
    if (!error || !description) return null;
    return {
      inSurface: true,
      selected: false,
      title: resolveEditorMessage(
        needUpload
          ? editorMessage(
              "com.myoxus.editor.resource.upload-failed",
              "Upload failed",
            )
          : editorMessage(
              "com.myoxus.editor.resource.download-failed",
              "Download failed",
            ),
        this.std.getOptional(EditorI18nProvider) ?? undefined,
      ),
      description,
      fileType: "image",
      loading: false,
      error: true,
      vertical: false,
      statusPopover: true,
      action: {
        kind: needUpload ? "retry" : "reload",
        run: () =>
          needUpload ? this.resourceController.upload() : this.refreshData(),
      },
    };
  }

  connectedCallback() {
    if (!this.connectBlock()) return;
    installEditorStyles(this, edgelessImageStyles);
    installEditorStyles(this, imageSelectedRectStyles);

    this.contentEditable = "false";

    this.resourceController.setEngine(this.std.store.blobSync);
    this.disposables.add(this.resourceController.subscribe());
    this.disposables.add(this.resourceController);

    this.disposables.add(
      this.model.props.sourceId$.subscribe(() => {
        this._resetLodSource(null);
        this.refreshData();
      }),
    );

    this.disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(({ zoom }) => {
        this._updateLodFromViewport(zoom);
      }),
    );

    this._lastShouldUseLod = this._shouldUseLod(this.blobUrl);

    const doc = this.ownerDocument;
    const container = doc.createElement("div");
    container.className = "myoxus-image-container";
    Object.assign(container.style, {
      display: "flex",
      position: "relative",
      width: "100%",
      height: "100%",
      transformOrigin: "center",
    });
    this._containerEl = container;

    const contentSlot = doc.createElement("div");
    contentSlot.style.display = "contents";
    this._contentSlotEl = contentSlot;

    const resizableImg = doc.createElement("div");
    resizableImg.className = "resizable-img";
    const img = doc.createElement("img");
    img.className = "drag-target";
    img.draggable = false;
    img.loading = "lazy";
    this.disposables.addFromEvent(img, "error", this._handleError);
    resizableImg.append(img);
    this.resizableImg = resizableImg;
    this._imgEl = img;

    const loadingEl = doc.createElement("div");
    loadingEl.className = "loading";
    loadingEl.append(
      createImageLoadingSpinner(doc, {
        strokeColor: cssVar("pureWhite"),
        ringColor: cssVar("white60"),
      }),
    );
    this._loadingEl = loadingEl;

    const statusEl = doc.createElement("span");
    statusEl.className = "myoxus-image-status";
    this._statusEl = statusEl;

    const selectionEl = doc.createElement("myoxus-block-selection");
    container.append(contentSlot, selectionEl);

    const captionEditor = doc.createElement(
      "block-caption-editor",
    ) as BlockCaptionEditor;
    captionEditor.model = this.model as unknown as BlockCaptionEditor["model"];
    captionEditor.std = this.std;
    this.captionEditor = captionEditor;

    this.replaceChildren(container, captionEditor);
    this.mountBlockWidgets(this);

    const statusControls$ = computed(() => this._buildStatusControls());
    const chrome = this.std.getOptional(EditorChromeHostIdentifier);
    if (chrome) {
      this.disposables.add(
        effect(() => {
          const active = Boolean(statusControls$.value);
          if (!active) {
            statusEl.remove();
            return;
          }
          if (this._showingImage && !statusEl.parentNode) {
            contentSlot.append(statusEl);
          }
          return untracked(() => {
            const unmount = chrome.mountAttachmentCard(
              statusEl,
              statusControls$,
            );
            return () => {
              unmount();
              statusEl.remove();
            };
          });
        }),
      );
    }

    this.bindGfx();
  }

  protected override renderGfxView() {
    if (!this._containerEl || !this._contentSlotEl || !this._imgEl) return;
    void this._lodRevision$.value;

    const blobUrl = this.blobUrl;
    const { rotate = 0, size = 0 } = this.model.props;
    const caption = this.model.props.caption$.value ?? "Image";
    this._resetLodSource(blobUrl);

    this._containerEl.style.transform = `rotate(${rotate}deg)`;

    const resolvedState = this.resourceController.resolveStateWith({
      title: "Image",
      description: formatSize(size),
    });

    const { loading, description, error } = resolvedState;
    const shouldUseLod = this._shouldUseLod(blobUrl);
    if (shouldUseLod && blobUrl) {
      this._ensureLodThumbnail(blobUrl);
    }
    this._lastShouldUseLod = shouldUseLod;
    const imageUrl =
      shouldUseLod && this._lodThumbnailUrl ? this._lodThumbnailUrl : blobUrl;

    if (blobUrl) {
      this._showingImage = true;
      this._fallbackCardEl = null;
      if (this.resizableImg.parentNode !== this._contentSlotEl) {
        this._contentSlotEl.replaceChildren(this.resizableImg);
      }

      const nextSrc = imageUrl ?? "";
      if (this._imgEl.getAttribute("src") !== nextSrc) {
        this._imgEl.setAttribute("src", nextSrc);
      }
      if (this._imgEl.alt !== caption) {
        this._imgEl.alt = caption;
      }

      if (this._loadingEl) {
        if (loading) {
          if (!this._loadingEl.parentNode) {
            this._contentSlotEl.append(this._loadingEl);
          }
        } else if (this._loadingEl.parentNode) {
          this._loadingEl.remove();
        }
      }

      if (this._statusEl) {
        if (error && description) {
          if (!this._statusEl.parentNode) {
            this._contentSlotEl.append(this._statusEl);
          }
        } else if (this._statusEl.parentNode) {
          this._statusEl.remove();
        }
      }
      return;
    }

    this._showingImage = false;
    if (!this._fallbackCardEl) {
      const fallback = this.ownerDocument.createElement(
        "myoxus-image-fallback-card",
      ) as ImageBlockFallbackCard;
      fallback.std = this.std;
      fallback.inSurface = true;
      fallback.state = resolvedState;
      this._fallbackCardEl = fallback;
      this._contentSlotEl.replaceChildren(fallback);
    } else {
      this._fallbackCardEl.state = resolvedState;
    }
  }

  override disconnectedCallback() {
    this._lodGenerationToken += 1;
    this._lodGeneratingSourceUrl = null;
    this._lodSourceUrl = null;
    this._revokeLodThumbnail();
    this._containerEl = null;
    this._contentSlotEl = null;
    this._imgEl = null;
    this._loadingEl = null;
    this._statusEl = null;
    this._fallbackCardEl = null;
    this._showingImage = false;
    this.captionEditor = null;
    super.disconnectedCallback();
    this.replaceChildren();
  }
}

export const ImageEdgelessBlockInteraction = GfxViewInteractionExtension(
  ImageBlockSchema.model.flavour,
  {
    resizeConstraint: {
      lockRatio: true,
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-image": ImageEdgelessBlockComponent;
  }
}
