import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import { ViewExtensionManagerIdentifier } from "@virgultum/editor/ext-loader";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { createElement } from "react";
import { Doc as YDoc } from "yjs";

import { PPTBuilder } from "../slides/index";
import { getAIPanelWidget } from "../utils/ai-widgets";
import type { AIContext } from "../utils/context";
import type { MyoxusAIPanelWidgetConfig } from "../widgets/ai-panel/type";

export const createSlidesRenderer: (
  host: EditorHost,
  ctx: AIContext,
) => MyoxusAIPanelWidgetConfig["answerRenderer"] = (host, ctx) => {
  return (answer, state) => {
    if (state === "generating") {
      const panel = getAIPanelWidget(host);
      panel.generatingElement?.updateLoadingProgress(2);
      return null;
    }

    if (state !== "finished" && state !== "error") {
      return null;
    }

    return createElement("ai-slides-renderer", { host, ctx, text: answer });
  };
};

const STYLES = `
  :host {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
  }

  .slides-container {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .edgeless-container {
    width: 100%;
    height: 100%;
    border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
      ${unsafeCSSVar("borderColor")};
  }

  .mask {
    position: absolute;
    inset: 0;
    z-index: 1;
    background-color: transparent;
    pointer-events: none;
  }

  .edgeless-container [data-canvas-zoom],
  edgeless-toolbar {
    display: none;
  }

  * {
    box-sizing: border-box;
  }

  .myoxus-edgeless-viewport {
    display: block;
    height: 100%;
    position: relative;
    overflow: hidden;
    container-name: viewport;
    container-type: inline-size;
  }

  .myoxus-edgeless-surface-block-container {
    position: absolute;
    width: 100%;
    height: 100%;
  }

  .myoxus-edgeless-surface-block-container canvas {
    width: 100%;
    height: 100%;
    position: relative;
    z-index: 1;
    pointer-events: none;
  }

  edgeless-block-portal-container {
    position: relative;
    box-sizing: border-box;
    overflow: hidden;
    display: block;
    height: 100%;
    color: ${unsafeCSSVar("textPrimaryColor")};
  }

  .myoxus-block-children-container.edgeless {
    padding-left: 0;
    position: relative;
    overflow: hidden;
    height: 100%;
    touch-action: none;
    background-color: ${unsafeCSSVar("backgroundPrimaryColor")};
    background-image: radial-gradient(
      var(--myoxus-edgeless-grid-color)
        ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")},
      ${unsafeCSSVar("backgroundPrimaryColor")}
        ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")}
    );
    z-index: 0;
  }

  .myoxus-edgeless-block-child {
    position: absolute;
    transform-origin: center;
    box-sizing: border-box;
    border: calc(${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} * 2)
      solid ${unsafeCSSVar("borderColor")};
    border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
    box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
    pointer-events: all;
  }

  myoxus-edgeless-image .resizable-img,
  myoxus-edgeless-image .resizable-img img {
    width: 100%;
    height: 100%;
  }

  .myoxus-edgeless-layer {
    position: absolute;
    top: 0;
    left: 0;
    contain: size layout style;
  }

  ${fontSMStyle("edgeless-block-portal-container")}
`;

export class AISlidesRenderer extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _shadow: ShadowRoot;
  private readonly _edgelessContainer: HTMLDivElement;

  private _doc!: Store;
  private _docCollection: WorkspaceImpl | null = null;
  private _editorHost: EditorHost | null = null;
  private _mounted = false;

  text!: string;
  host!: EditorHost;
  ctx:
    | {
        get(): Record<string, unknown>;
        set(data: Record<string, unknown>): void;
      }
    | undefined = undefined;

  constructor() {
    super();
    this._shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;

    const slidesContainer = document.createElement("div");
    slidesContainer.className = "slides-container";

    this._edgelessContainer = document.createElement("div");
    this._edgelessContainer.className =
      "edgeless-container myoxus-edgeless-viewport";

    const mask = document.createElement("div");
    mask.className = "mask";

    slidesContainer.append(this._edgelessContainer, mask);
    this._shadow.append(style, slidesContainer);
  }

  protected _getExtensions() {
    return this.host.std
      .get(ViewExtensionManagerIdentifier)
      .get("preview-edgeless");
  }

  connectedCallback(): void {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }

    const collection = new WorkspaceImpl({
      id: "SLIDES_PREVIEW",
      rootDoc: new YDoc({ guid: "SLIDES_PREVIEW" }),
    });
    collection.meta.initialize();
    const doc = collection.createDoc().getStore();

    doc.load(() => {
      const pageBlockId = doc.addBlock("myoxus:page", {});
      doc.addBlock("myoxus:surface", {}, pageBlockId);
    });

    doc.resetHistory();
    this._doc = doc;
    this._docCollection = collection;

    if (this.host && !this._mounted) {
      this._mounted = true;
      const editorHost = new BlockStdScope({
        store: this._doc,
        extensions: this._getExtensions(),
      }).render();
      this._editorHost = editorHost;
      this._edgelessContainer.replaceChildren(editorHost);

      requestAnimationFrame(() => {
        if (!this.isConnected || !this._editorHost) return;
        PPTBuilder(this._editorHost, this.host)
          ?.process(this.text)
          .then((res) => {
            if (res && this.ctx) {
              this.ctx.set({
                contents: res.contents,
                images: res.images,
              });
              // refresh loading menu item
              getAIPanelWidget(this.host).requestUpdate();
            }
          })
          .catch(console.error);
      });
    }
  }

  disconnectedCallback(): void {
    this._mounted = false;
    this._editorHost = null;
    this._edgelessContainer.replaceChildren();
    this._docCollection?.dispose();
    this._docCollection = null;
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-slides-renderer": AISlidesRenderer;
  }
}
