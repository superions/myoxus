import { ViewExtensionManagerIdentifier } from "@virgultum/core/extensions";
import type { FrameBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import { Bound, deserializeXYWH } from "@virgultum/core/primitives/gfx";
import {
  BlockStdScope,
  type EditorHost,
  LifeCycleWatcher,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  DocModeExtension,
  DocModeProvider,
  ViewportElementExtension,
} from "@virgultum/core/services";
import type { ExtensionType, Query, Store } from "@virgultum/core/store";
import debounce from "lodash-es/debounce";

const DEFAULT_PREVIEW_CONTAINER_WIDTH = 280;
const DEFAULT_PREVIEW_CONTAINER_HEIGHT = 166;

const STYLE_ID = "myoxus-frame-preview-styles";
const STYLES = `
  .frame-preview-container {
    display: block;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    position: relative;
  }

  .frame-preview-surface-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    overflow: hidden;
  }

  .frame-preview-viewport {
    max-width: 100%;
    box-sizing: border-box;
    margin: 0 auto;
    position: relative;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
  }

  .frame-preview-viewport
    > editor-host
    > myoxus-edgeless-root-preview
    > .edgeless-background {
    background-color: transparent;
    background-image: none;
  }
`;

function ensureStyles(doc: Document) {
  if (!doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.append(style);
}

export const MYOXUS_FRAME_PREVIEW = "frame-preview";

export class FramePreview extends NativeViewElement {
  disposables = new DisposableGroup();

  private _std!: BlockStdScope;
  private _fillScreen = false;
  private _frame!: FrameBlockModel;
  private _frameViewportWH = {
    width: 0,
    height: 0,
  };
  private _surfaceHeight: number = DEFAULT_PREVIEW_CONTAINER_HEIGHT;
  private _surfaceWidth: number = DEFAULT_PREVIEW_CONTAINER_WIDTH;

  private _containerEl: HTMLDivElement | null = null;
  private _surfaceContainerEl: HTMLDivElement | null = null;
  private _viewportEl: HTMLDivElement | null = null;
  private _renderedKey: [Store | null, FrameBlockModel | null] = [null, null];

  private readonly _clearFrameDisposables = () => {
    this._frameDisposables?.dispose();
    this._frameDisposables = null;
  };

  private readonly _docFilter: Query = {
    mode: "loose",
    match: [
      {
        flavour: "myoxus:frame",
        viewType: "hidden",
      },
    ],
  };

  private _frameDisposables: DisposableGroup | null = null;

  private _previewDoc: Store | null = null;

  private _runtimePreviewExt: ExtensionType[] = [];

  get std(): BlockStdScope {
    return this._std;
  }
  set std(value: BlockStdScope) {
    const changed = this._std !== value;
    this._std = value;
    if (changed && this.isConnected && value) {
      this._initSpec();
      this._render();
    }
  }

  get fillScreen(): boolean {
    return this._fillScreen;
  }
  set fillScreen(value: boolean) {
    if (this._fillScreen === value) return;
    this._fillScreen = value;
    if (this.isConnected && this._frame) {
      this._updateFrameViewportWH();
    }
  }

  get frame(): FrameBlockModel {
    return this._frame;
  }
  set frame(value: FrameBlockModel) {
    const changed = this._frame !== value;
    this._frame = value;
    if (changed && this.isConnected && value) {
      if (!this._previewDoc) {
        this._initPreviewDoc();
      }
      this._setFrameDisposables(value);
      this._updateFrameViewportWH();
      this._render();
    }
  }

  get frameViewportWH(): { width: number; height: number } {
    return this._frameViewportWH;
  }
  set frameViewportWH(value: { width: number; height: number }) {
    this._frameViewportWH = value;
    this._syncDimensions();
    this._refreshViewport();
  }

  get previewEditor(): EditorHost | null {
    return this.querySelector("editor-host") as EditorHost | null;
  }

  get surfaceHeight(): number {
    return this._surfaceHeight;
  }
  set surfaceHeight(value: number) {
    this._surfaceHeight = value;
    if (this.isConnected && this._frame) {
      this._updateFrameViewportWH();
    } else {
      this._syncDimensions();
    }
  }

  get surfaceWidth(): number {
    return this._surfaceWidth;
  }
  set surfaceWidth(value: number) {
    this._surfaceWidth = value;
    if (this.isConnected && this._frame) {
      this._updateFrameViewportWH();
    } else {
      this._syncDimensions();
    }
  }

  private get _viewExtensionManager() {
    return this.std.get(ViewExtensionManagerIdentifier);
  }

  private get _previewSpec() {
    return this._viewExtensionManager.get("preview-edgeless");
  }

  private readonly _updateFrameViewportWH = () => {
    if (!this._frame?.xywh) return;
    const [, , w, h] = deserializeXYWH(this._frame.xywh);

    let scale = 1;
    if (this._fillScreen) {
      scale = Math.max(this._surfaceWidth / w, this._surfaceHeight / h);
    } else {
      scale = Math.min(this._surfaceWidth / w, this._surfaceHeight / h);
    }

    this.frameViewportWH = {
      width: w * scale,
      height: h * scale,
    };
  };

  get _originalDoc() {
    return this.frame.store;
  }

  private _initPreviewDoc() {
    if (!this._frame) return;
    const doc = this._originalDoc.workspace.getDoc(this._originalDoc.id);
    this._previewDoc =
      doc?.getStore({ readonly: true, query: this._docFilter }) ?? null;
    const originalDoc = this._originalDoc;
    this.disposables.add(() => {
      originalDoc.doc.removeStore({ query: this._docFilter });
    });
  }

  private _initSpec() {
    if (!this._std) return;
    const refreshViewport = this._refreshViewport.bind(this);
    class FramePreviewWatcher extends LifeCycleWatcher {
      static override key = "frame-preview-watcher";

      override mounted() {
        const std = this.std;
        const { view } = std;
        view.viewUpdated.subscribe((payload) => {
          if (
            payload.type !== "block" ||
            payload.method !== "add" ||
            payload.view.model.flavour !== "myoxus:page"
          ) {
            return;
          }
          const viewport = std.get(GfxControllerIdentifier).viewport;
          const subscription = viewport.sizeUpdated.subscribe(() => {
            subscription.unsubscribe();
            refreshViewport();
          });
        });
      }
    }

    const docModeService = this._std.get(DocModeProvider);
    this._runtimePreviewExt = [
      ViewportElementExtension(".frame-preview-viewport"),
      FramePreviewWatcher,
      DocModeExtension(docModeService),
    ];
  }

  private _refreshViewport() {
    const previewEditorHost = this.previewEditor;

    if (!previewEditorHost || !this._frame?.xywh) return;

    const { viewport } = previewEditorHost.std.get(GfxControllerIdentifier);
    const frameBound = Bound.deserialize(this._frame.xywh);
    viewport.setViewportByBound(frameBound);
  }

  private _syncDimensions() {
    if (this._surfaceContainerEl) {
      this._surfaceContainerEl.style.width = `${this._surfaceWidth}px`;
      this._surfaceContainerEl.style.height = `${this._surfaceHeight}px`;
    }
    if (this._viewportEl) {
      this._viewportEl.style.width = `${this._frameViewportWH.width}px`;
      this._viewportEl.style.height = `${this._frameViewportWH.height}px`;
    }
  }

  private _render() {
    if (!this._containerEl) return;
    const noContent = !this._frame || !this._frame.xywh || !this._std;
    if (noContent) {
      this._containerEl.replaceChildren();
      this._surfaceContainerEl = null;
      this._viewportEl = null;
      this._renderedKey = [null, null];
      return;
    }

    if (!this._surfaceContainerEl || !this._viewportEl) {
      this._surfaceContainerEl = this.ownerDocument.createElement("div");
      this._surfaceContainerEl.className = "frame-preview-surface-container";
      this._viewportEl = this.ownerDocument.createElement("div");
      this._viewportEl.className = "frame-preview-viewport";
      this._surfaceContainerEl.append(this._viewportEl);
      this._containerEl.replaceChildren(this._surfaceContainerEl);
    }

    this._syncDimensions();

    const [prevDoc, prevFrame] = this._renderedKey;
    if (prevDoc !== this._previewDoc || prevFrame !== this._frame) {
      this._renderedKey = [this._previewDoc, this._frame];
      if (!this._previewDoc || !this._frame) {
        this._viewportEl.replaceChildren();
      } else {
        const previewSpec = this._previewSpec.concat(this._runtimePreviewExt);
        const host = new BlockStdScope({
          store: this._previewDoc,
          extensions: previewSpec,
        }).render();
        this._viewportEl.replaceChildren(host);
      }
    }
  }

  private _setFrameDisposables(frame: FrameBlockModel) {
    this._clearFrameDisposables();
    this._frameDisposables = new DisposableGroup();
    this._frameDisposables.add(
      frame.propsUpdated.subscribe(
        debounce(this._updateFrameViewportWH, 10, { leading: true }),
      ),
    );
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    ensureStyles(this.ownerDocument);
    if (!this._containerEl) {
      this._containerEl = this.ownerDocument.createElement("div");
      this._containerEl.className = "frame-preview-container";
      this.replaceChildren(this._containerEl);
    }
    if (this._std) {
      this._initSpec();
    }
    if (this._frame) {
      this._initPreviewDoc();
      this._updateFrameViewportWH();
      this._setFrameDisposables(this._frame);
    }
    this._render();
  }

  disconnectedCallback() {
    this._clearFrameDisposables();
    this._previewDoc = null;
    this._renderedKey = [null, null];
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_PREVIEW]: FramePreview;
  }
}
