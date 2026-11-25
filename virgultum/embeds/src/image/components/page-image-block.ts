import {
  EditorI18nProvider,
  EditorChromeHostIdentifier,
  type EditorAttachmentCardControls,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { computed, effect, signal, untracked } from "@preact/signals-core";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { ResolvedStateInfo } from "@virgultum/core/resource";
import {
  focusBlockEnd,
  focusBlockStart,
  getNextBlockCommand,
  getPrevBlockCommand,
} from "@virgultum/core/commands";
import { ImageSelection } from "@virgultum/core/selection";
import { cssVar } from "@virgultum/core/theme";
import {
  type BlockComponent,
  BlockSelection,
  installEditorStyles,
  NativeViewElement,
  TextSelection,
  type UIEventStateContext,
} from "@virgultum/core/runtime";
import type { BaseSelection } from "@virgultum/core/store";

import type { ImageBlockComponent } from "../image-block";
import { ImageResizeManager } from "../image-resize-manager";
import { shouldResizeImage } from "../utils";
import {
  createImageLoadingSpinner,
  createImageSelectedRect,
  imageSelectedRectStyles,
} from "./image-selected-rect";

const pageImageStyles = `
  myoxus-page-image {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 0;
    cursor: pointer;
  }

  myoxus-page-image .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 4px;
    left: 4px;
    width: 36px;
    height: 36px;
    padding: 5px;
    border-radius: 8px;
    background: var(--myoxus-black-10);
  }

  myoxus-page-image .loading > svg {
    font-size: 25.71px;
  }

  myoxus-page-image .myoxus-image-status {
    position: absolute;
    left: 18px;
    bottom: 18px;
  }

  myoxus-page-image .resizable-img {
    position: relative;
    max-width: 100%;
  }

  myoxus-page-image .resizable-img img {
    display: block;
    max-width: 100%;
    height: auto;
  }

  myoxus-page-image .resizable-img[data-myoxus-sized="true"] img {
    width: 100%;
    height: 100%;
  }

  myoxus-page-image .comment-highlighted {
    outline: 2px solid var(--myoxus-primary-color);
  }
`;

export class ImageBlockPageComponent extends NativeViewElement {
  private readonly _block$ = signal<ImageBlockComponent | null>(null);
  private readonly _state$ = signal<ResolvedStateInfo | null>(null);
  private readonly _intrinsicWidth$ = signal(0);
  private readonly _revision$ = signal(0);
  private _disposables = new DisposableGroup();
  private _isDragging = false;
  private _resizeImgEl: HTMLDivElement | null = null;

  resizeable$ = computed(() => this._block$.value?.resizeable$.value ?? false);

  get block() {
    return this._block$.value!;
  }
  set block(value: ImageBlockComponent) {
    this._block$.value = value;
  }

  get state() {
    return this._state$.value!;
  }
  set state(value: ResolvedStateInfo) {
    this._state$.value = value;
  }

  get resizeImg(): HTMLElement {
    return (
      this._resizeImgEl ?? this.querySelector<HTMLElement>(".resizable-img")!
    );
  }

  get updateComplete() {
    return Promise.resolve(this.isConnected);
  }

  requestUpdate() {
    this._revision$.value++;
  }

  private readonly _handleLoad = (event: Event) => {
    this._intrinsicWidth$.value = (
      event.currentTarget as HTMLImageElement
    ).naturalWidth;
  };

  private get _doc() {
    return this.block.store;
  }

  private get _host() {
    return this.block.host;
  }

  private get _model() {
    return this.block.model;
  }

  private _bindKeyMap() {
    const selection = this._host.selection;

    const addParagraph = (ctx: UIEventStateContext) => {
      const parent = this._doc.getParent(this._model);
      if (!parent) return;

      const index = parent.children.indexOf(this._model);
      const blockId = this._doc.addBlock(
        "myoxus:paragraph",
        {},
        parent,
        index + 1,
      );

      const event = ctx.get("defaultState").event;
      event.preventDefault();

      selection.update((selList) =>
        selList
          .filter<BaseSelection>((sel) => !sel.is(ImageSelection))
          .concat(
            selection.create(TextSelection, {
              from: {
                blockId,
                index: 0,
                length: 0,
              },
              to: null,
            }),
          ),
      );
    };

    // TODO: use key map extension
    this.block.bindHotKey({
      Escape: () => {
        selection.update((selList) => {
          return selList.map((sel) => {
            const current =
              sel.is(ImageSelection) && sel.blockId === this.block.blockId;
            if (current) {
              return selection.create(BlockSelection, {
                blockId: this.block.blockId,
              });
            }
            return sel;
          });
        });
        return true;
      },
      Delete: (ctx) => {
        if (this._host.store.readonly || !this.resizeable$.peek()) return;

        addParagraph(ctx);
        this._doc.deleteBlock(this._model);
        return true;
      },
      Backspace: (ctx) => {
        if (this._host.store.readonly || !this.resizeable$.peek()) return;

        addParagraph(ctx);
        this._doc.deleteBlock(this._model);
        return true;
      },
      Enter: (ctx) => {
        if (this._host.store.readonly || !this.resizeable$.peek()) return;

        addParagraph(ctx);
        return true;
      },
      ArrowDown: (ctx) => {
        const std = this._host.std;

        // If the selection is not image selection, we should not handle it.
        if (!std.selection.find(ImageSelection)) {
          return false;
        }

        const event = ctx.get("keyboardState");
        event.raw.preventDefault();

        std.command
          .chain()
          .pipe(getNextBlockCommand, { path: this.block.blockId })
          .pipe<{ focusBlock: BlockComponent }>((ctx, next) => {
            const { nextBlock } = ctx;
            if (!nextBlock) return;

            return next({ focusBlock: nextBlock });
          })
          .pipe(focusBlockStart)
          .run();
        return true;
      },
      ArrowUp: (ctx) => {
        const std = this._host.std;

        // If the selection is not image selection, we should not handle it.
        if (!std.selection.find(ImageSelection)) {
          return false;
        }

        const event = ctx.get("keyboardState");
        event.raw.preventDefault();

        std.command
          .chain()
          .pipe(getPrevBlockCommand, { path: this.block.blockId })
          .pipe<{ focusBlock: BlockComponent }>((ctx, next) => {
            const { prevBlock } = ctx;
            if (!prevBlock) return;

            return next({ focusBlock: prevBlock });
          })
          .pipe(focusBlockEnd)
          .run();
        return true;
      },
    });
  }

  private readonly _handleError = () => {
    this.block.resourceController?.updateState({
      errorMessage: "Failed to download image!",
    });
  };

  private _handleSelection(resizeImg: HTMLElement) {
    const selection = this._host.selection;

    this._disposables.addFromEvent(resizeImg, "click", (event: MouseEvent) => {
      // the peek view need handle shift + click
      if (event.shiftKey) return;

      event.stopPropagation();
      selection.update((selList) => {
        return selList
          .filter((sel) => !["block", "image", "text"].includes(sel.type))
          .concat(
            selection.create(ImageSelection, { blockId: this.block.blockId }),
          );
      });
      return true;
    });

    this.block.handleEvent(
      "click",
      () => {
        if (!this.resizeable$.peek()) return;

        selection.update((selList) =>
          selList.filter(
            (sel) =>
              !(sel.is(ImageSelection) && sel.blockId === this.block.blockId),
          ),
        );
      },
      {
        global: true,
      },
    );
  }

  private _normalizeImageSize() {
    // If is dragging, we should use the real size of the image
    if (this._isDragging && this._resizeImgEl) {
      return this._resizeImgEl.style.width;
    }

    const { width, height } = this._model.props;
    if (!width || !height) {
      // Imported images have no authored dimensions. An unsized SVG inside
      // the flex/percentage container can otherwise collapse to zero width.
      // Use decoded geometry only for rendering; loading must not edit Yjs.
      const intrinsicWidth = this._intrinsicWidth$.value;
      return intrinsicWidth ? `${intrinsicWidth}px` : "";
    }

    return `${width}px`;
  }

  private _hasStoredImageSize() {
    const { width, height } = this._model.props;
    return Boolean(width && height);
  }

  private _observeDrag() {
    const imageResizeManager = new ImageResizeManager();

    this._disposables.add(
      this._host.event.add("dragStart", (ctx) => {
        const pointerState = ctx.get("pointerState");
        const target = pointerState.event.target;
        if (shouldResizeImage(this, target)) {
          this._isDragging = true;
          imageResizeManager.onStart(pointerState);
          return true;
        }
        return false;
      }),
    );

    this._disposables.add(
      this._host.event.add("dragMove", (ctx) => {
        const pointerState = ctx.get("pointerState");
        if (this._isDragging) {
          imageResizeManager.onMove(pointerState);
          return true;
        }
        return false;
      }),
    );

    this._disposables.add(
      this._host.event.add("dragEnd", () => {
        if (this._isDragging) {
          this._isDragging = false;
          imageResizeManager.onEnd();
          return true;
        }
        return false;
      }),
    );
  }

  private _buildStatusControls(): EditorAttachmentCardControls | null {
    const state = this._state$.value;
    const block = this._block$.value;
    if (!state || !block || !state.error || !state.description) return null;
    const { description, needUpload } = state;
    return {
      inSurface: false,
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
        block.std.getOptional(EditorI18nProvider) ?? undefined,
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
          needUpload ? block.resourceController.upload() : block.refreshData(),
      },
    };
  }

  connectedCallback() {
    installEditorStyles(this, pageImageStyles);
    installEditorStyles(this, imageSelectedRectStyles);

    this._disposables.dispose();
    this._disposables = new DisposableGroup();

    const doc = this.ownerDocument;
    const resizeImg = doc.createElement("div");
    resizeImg.className = "resizable-img";
    this._resizeImgEl = resizeImg;

    const img = doc.createElement("img");
    img.className = "drag-target";
    img.draggable = false;
    img.loading = "lazy";
    this._disposables.addFromEvent(img, "load", this._handleLoad);
    this._disposables.addFromEvent(img, "error", this._handleError);
    resizeImg.append(img);

    const loadingEl = doc.createElement("div");
    loadingEl.className = "loading";
    loadingEl.append(
      createImageLoadingSpinner(doc, {
        strokeColor: cssVar("pureWhite"),
        ringColor: cssVar("white60"),
      }),
    );

    const statusEl = doc.createElement("span");
    statusEl.className = "myoxus-image-status";

    this.replaceChildren(resizeImg);

    if (this._block$.peek()?.host) {
      this._bindKeyMap();
      this._observeDrag();
      this._handleSelection(resizeImg);
    }

    // The embed block can not be focused,
    // so the active element will be the last activated element.
    // If the active element is the title textarea,
    // any event will dispatch from it and be ignored. (Most events will ignore title)
    // so we need to blur it.
    // See also https://developer.mozilla.org/en-US/docs/Web/API/Document/activeElement
    this._disposables.addFromEvent(this, "click", () => {
      if (
        document.activeElement &&
        document.activeElement instanceof HTMLElement
      ) {
        document.activeElement.blur();
      }
    });

    if (this._block$.peek()?.model?.propsUpdated) {
      this._disposables.add(
        this._block$.peek()!.model.propsUpdated.subscribe(() => {
          this.requestUpdate();
        }),
      );
    }

    let selectedRectEl: HTMLDivElement | null = null;
    let lastSelectedReadonly: boolean | null = null;

    this._disposables.add(
      effect(() => {
        void this._revision$.value;
        const block = this._block$.value;
        const state = this._state$.value;
        if (!block || !state) return;

        resizeImg.classList.toggle(
          "comment-highlighted",
          block.isCommentHighlighted,
        );
        resizeImg.dataset.myoxusSized = this._hasStoredImageSize()
          ? "true"
          : "false";
        resizeImg.style.width = this._normalizeImageSize();

        const blobUrl = block.blobUrl ?? "";
        if (img.getAttribute("src") !== blobUrl) {
          img.setAttribute("src", blobUrl);
        }
        const caption = block.model.props.caption$.value ?? "Image";
        if (img.alt !== caption) {
          img.alt = caption;
        }

        const showSelectedRect = this.resizeable$.value;
        const readonly = block.store?.readonly ?? false;
        if (showSelectedRect) {
          if (!selectedRectEl || lastSelectedReadonly !== readonly) {
            selectedRectEl?.remove();
            selectedRectEl = createImageSelectedRect(doc, readonly);
            lastSelectedReadonly = readonly;
            resizeImg.append(selectedRectEl);
          }
        } else if (selectedRectEl) {
          selectedRectEl.remove();
          selectedRectEl = null;
          lastSelectedReadonly = null;
        }

        if (state.loading) {
          if (!loadingEl.parentNode) {
            this.append(loadingEl);
          }
        } else if (loadingEl.parentNode) {
          loadingEl.remove();
        }
      }),
    );

    const statusControls$ = computed(() => this._buildStatusControls());
    this._disposables.add(
      effect(() => {
        const block = this._block$.value;
        const chrome = block?.std?.getOptional(EditorChromeHostIdentifier);
        const active = Boolean(statusControls$.value);
        if (!chrome || !active) {
          statusEl.remove();
          return;
        }
        if (!statusEl.parentNode) {
          this.append(statusEl);
        }
        return untracked(() => {
          const unmount = chrome.mountAttachmentCard(statusEl, statusControls$);
          return () => {
            unmount();
            statusEl.remove();
          };
        });
      }),
    );
  }

  disconnectedCallback() {
    this._disposables.dispose();
    this._resizeImgEl = null;
    this.replaceChildren();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-page-image": ImageBlockPageComponent;
  }
}
