import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import { ViewExtensionManagerIdentifier } from "@virgultum/editor/ext-loader";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { css, html, LitElement, nothing } from "lit";
import { property, query } from "lit/decorators.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
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
      return nothing;
    }

    if (state !== "finished" && state !== "error") {
      return nothing;
    }

    return html`<ai-slides-renderer
      .host=${host}
      .ctx=${ctx}
      .text=${answer}
    ></ai-slides-renderer>`;
  };
};

export class AISlidesRenderer extends WithDisposable(LitElement) {
  static override styles = css`
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

    .edgeless-container myoxus-edgeless-zoom-toolbar-widget,
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

  private readonly _editorContainer: Ref<HTMLDivElement> =
    createRef<HTMLDivElement>();

  private _doc!: Store;

  private _docCollection: WorkspaceImpl | null = null;

  @query("editor-host")
  private accessor _editorHost!: EditorHost;

  @property({ attribute: false })
  accessor text!: string;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor ctx:
    | {
        get(): Record<string, unknown>;
        set(data: Record<string, unknown>): void;
      }
    | undefined = undefined;

  protected override firstUpdated() {
    requestAnimationFrame(() => {
      if (!this._editorHost) return;
      PPTBuilder(this._editorHost, this.host)
        ?.process(this.text)
        .then((res) => {
          if (res && this.ctx) {
            this.ctx.set({
              contents: res.contents,
              images: res.images,
            });
            // refresh loading menu item
            getAIPanelWidget(this.host)
              .shadowRoot?.querySelector("ai-panel-answer")
              ?.requestUpdate();
          }
        })
        .catch(console.error);
    });
  }

  protected _getExtensions() {
    return this.host.std
      .get(ViewExtensionManagerIdentifier)
      .get("preview-edgeless");
  }

  protected override render() {
    return html`<div class="slides-container">
      <div
        class="edgeless-container myoxus-edgeless-viewport"
        ${ref(this._editorContainer)}
      >
        ${new BlockStdScope({
          store: this._doc,
          extensions: this._getExtensions(),
        }).render()}
      </div>
      <div class="mask"></div>
    </div>`;
  }

  override connectedCallback(): void {
    super.connectedCallback();

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
  }

  override disconnectedCallback(): void {
    this._docCollection?.dispose();
    super.disconnectedCallback();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-slides-renderer": AISlidesRenderer;
  }
}
