import {
  convertMermaidCodeBlockCommand,
  mermaidMessages,
  MermaidRenderSourceError,
  renderMermaidSvg,
} from "@virgultum/block-mermaid";
import type { CodeBlockComponent } from "@virgultum/editor/blocks/code";
import { CodeBlockPreviewExtension } from "@virgultum/editor/blocks/code";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import type { CodeBlockModel } from "@virgultum/editor/model";
import { unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";
import { styleMap } from "lit/directives/style-map.js";

export const CodeBlockMermaidPreview = CodeBlockPreviewExtension(
  "mermaid",
  (model, blockComponent) =>
    html`<mermaid-preview
      .blockComponent=${blockComponent ?? null}
      .model=${model}
    ></mermaid-preview>`,
);

export class MermaidPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    .mermaid-preview-loading {
      color: ${unsafeCSSVar("placeholderColor")};
      font-feature-settings:
        "liga" off,
        "clig" off;

      /* light/code/base */
      font-family: "IBM Plex Mono";
      font-size: 12px;
      font-style: normal;
      font-weight: 400;
      line-height: normal;
    }

    .mermaid-preview-error,
    .mermaid-preview-fallback {
      color: ${unsafeCSSVar("errorColor")};
      font-feature-settings:
        "liga" off,
        "clig" off;

      /* light/code/base */
      font-family: "IBM Plex Mono";
      font-size: 12px;
      font-style: normal;
      font-weight: 400;
      line-height: normal;
    }

    .mermaid-preview-container {
      width: 100%;
      min-height: 300px;
      max-height: 600px;
      border: 1px solid ${unsafeCSSVar("borderColor")};
      border-radius: 8px;
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      overflow: hidden;
      position: relative;
      cursor: grab;
    }

    .mermaid-preview-container:active {
      cursor: grabbing;
    }

    .mermaid-preview-svg {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.1s ease-out;
    }

    .mermaid-preview-svg > div {
      display: flex;
      justify-content: center;
      width: 100%;
      transform-origin: center;
    }

    .mermaid-preview-svg svg {
      transform-origin: center;
    }

    .mermaid-controls {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 4px;
      z-index: 10;
    }

    .mermaid-control-button {
      width: 32px;
      height: 32px;
      border: 1px solid ${unsafeCSSVar("borderColor")};
      border-radius: 4px;
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      color: ${unsafeCSSVar("textPrimaryColor")};
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      transition: all 0.2s ease;
    }

    .mermaid-control-button:hover {
      background: ${unsafeCSSVar("hoverColor")};
      border-color: ${unsafeCSSVar("primaryColor")};
    }

    .mermaid-control-button:active {
      transform: scale(0.95);
    }

    .mermaid-control-button.disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .mermaid-scale-info {
      position: absolute;
      bottom: 8px;
      left: 8px;
      background: ${unsafeCSSVar("backgroundOverlayPanelColor")};
      border: 1px solid ${unsafeCSSVar("borderColor")};
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      color: ${unsafeCSSVar("textSecondaryColor")};
      z-index: 10;
    }
  `;

  @property({ attribute: false })
  accessor model: CodeBlockModel | null = null;

  @property({ attribute: false })
  accessor blockComponent: CodeBlockComponent | null = null;

  @property({ attribute: false })
  accessor mermaidCode: string | null = null;

  @state()
  accessor state: "loading" | "error" | "finish" | "empty" = "loading";

  @state()
  accessor sourceError: string = "";

  @state()
  accessor svgContent: string = "";

  @query(".mermaid-preview-container")
  accessor container!: HTMLDivElement;

  private retryCount = 0;
  private readonly maxRetries = 3;
  private renderTimeout: ReturnType<typeof setTimeout> | null = null;
  private isRendering = false;

  // zoom and pan
  private scale = 1;
  private translateX = 0;
  private translateY = 0;
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  override firstUpdated(_changedProperties: PropertyValues): void {
    this._scheduleRender();
    this._setupEventListeners();

    if (this.model) {
      this.disposables.add(
        this.model.props.text$.subscribe(() => {
          this._scheduleRender();
        }),
      );
    }
  }

  override willUpdate(changedProperties: PropertyValues<this>) {
    if (changedProperties.has("mermaidCode")) {
      this._scheduleRender();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // clear timeout
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
  }

  get normalizedMermaidCode() {
    return this.model?.props.text.toString() ?? this.mermaidCode;
  }

  private _scheduleRender() {
    // clear previous timeout
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
    }

    // set debounce timeout
    this.renderTimeout = setTimeout(() => {
      this._render().catch((error) => {
        console.error("Failed to render in timeout:", error);
      });
    }, 100);
  }

  private _resetTransform() {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this._updateTransform();
  }

  private _convertToMermaidBlock() {
    const block = this.blockComponent;
    if (!block || block.store.readonly || !this.model) return;
    block.std.command.exec(convertMermaidCodeBlockCommand, {
      model: this.model,
    });
  }

  private _zoomIn() {
    this.scale = Math.min(this.scale * 1.2, 5);
    this._updateTransform();
  }

  private _zoomOut() {
    this.scale = Math.max(this.scale / 1.2, 0.1);
    this._updateTransform();
  }

  private _updateTransform() {
    // trigger re-render to update transform
    this.requestUpdate();
  }

  private readonly _handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return; // only handle left click
    this.isDragging = true;
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
    this.container.style.cursor = "grabbing";
  };

  private readonly _handleMouseMove = (event: MouseEvent) => {
    if (!this.isDragging) return;

    const deltaX = event.clientX - this.lastMouseX;
    const deltaY = event.clientY - this.lastMouseY;

    this.translateX += deltaX;
    this.translateY += deltaY;

    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;

    this._updateTransform();
  };

  private readonly _handleMouseUp = () => {
    this.isDragging = false;
    this.container.style.cursor = "grab";
  };

  private readonly _handleWheel = (event: WheelEvent) => {
    event.preventDefault();

    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(5, this.scale * delta));

    // calculate mouse position relative to container
    const rect = this.container.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // calculate scale center point
    const scaleCenterX = mouseX - this.translateX;
    const scaleCenterY = mouseY - this.translateY;

    // update transform
    this.scale = newScale;
    this.translateX = mouseX - scaleCenterX * (newScale / this.scale);
    this.translateY = mouseY - scaleCenterY * (newScale / this.scale);

    this._updateTransform();
  };

  private _setupEventListeners() {
    // mouse events
    this.disposables.addFromEvent(
      this.container,
      "mousedown",
      this._handleMouseDown,
    );
    this.disposables.addFromEvent(document, "mousemove", this._handleMouseMove);
    this.disposables.addFromEvent(document, "mouseup", this._handleMouseUp);

    // wheel events
    this.disposables.addFromEvent(this.container, "wheel", this._handleWheel);

    // prevent text selection when dragging
    this.disposables.addFromEvent(this.container, "selectstart", (e) =>
      e.preventDefault(),
    );
  }

  private async _render() {
    // prevent duplicate rendering
    if (this.isRendering) {
      return;
    }

    this.isRendering = true;
    this.state = "loading";
    this.sourceError = "";

    if (!this.normalizedMermaidCode) {
      this.state = "empty";
      this.isRendering = false;
      return;
    }

    try {
      const { svg } = await renderMermaidSvg(this.normalizedMermaidCode, {
        idPrefix: "mermaid-code-preview",
      });

      // update SVG content
      this.svgContent = svg;
      this.state = svg ? "finish" : "empty";
      this.retryCount = 0; // reset retry count

      // reset transform
      this._resetTransform();
    } catch (error) {
      if (error instanceof MermaidRenderSourceError) {
        this.state = "error";
        this.sourceError = error.message;
        this.retryCount = 0;
        return;
      }
      console.error("Mermaid preview failed:", error);

      // retry mechanism
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        console.log(
          `Retrying mermaid render (${this.retryCount}/${this.maxRetries})`,
        );
        setTimeout(() => {
          this._render().catch((error) => {
            console.error("Failed to render in retry:", error);
          });
        }, 1000); // retry after 1 second
        return;
      }

      this.state = "error";
      this.retryCount = 0; // reset retry count
    } finally {
      this.isRendering = false;
    }
  }

  override render() {
    return html`
      <div class="mermaid-preview-wrapper">
        ${choose(this.state, [
          [
            "loading",
            () =>
              html`<div class="mermaid-preview-loading">
                <div style="text-align: center; padding: 20px;">
                  <div style="margin-bottom: 8px;">
                    Rendering Mermaid diagram...
                  </div>
                  <div style="font-size: 10px; opacity: 0.6;">Please wait</div>
                </div>
              </div>`,
          ],
          [
            "error",
            () =>
              html`<div class="mermaid-preview-error">
                <div style="text-align: center; padding: 20px;">
                  <div style="margin-bottom: 8px;">
                    Failed to render diagram
                  </div>
                  <div style="font-size: 10px; opacity: 0.6;">
                    ${
                      this.sourceError ||
                      "Please check if your Mermaid code has syntax errors"
                    }
                  </div>
                </div>
              </div>`,
          ],
          [
            "empty",
            () =>
              html`<div class="mermaid-preview-fallback">
                <div style="text-align: center; padding: 20px;">
                  ${mermaidMessages.previewEmpty()}
                </div>
              </div>`,
          ],
        ])}
        <div
          class="mermaid-preview-container"
          style=${styleMap({
            display: this.state === "finish" ? undefined : "none",
          })}
        >
          ${
            this.state === "finish"
              ? html`
                  <div
                    class="mermaid-preview-svg"
                    style=${styleMap({
                      transform: `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`,
                    })}
                  >
                    ${
                      this.svgContent
                        ? html`<div .innerHTML=${this.svgContent}></div>`
                        : nothing
                    }
                  </div>
                  <div class="mermaid-controls">
                    ${
                      this.blockComponent && !this.blockComponent.store.readonly
                        ? html`<button
                            class="mermaid-control-button mermaid-convert-button"
                            @click=${this._convertToMermaidBlock}
                            title="Convert to Mermaid block"
                            aria-label="Convert to Mermaid block"
                          >
                            ↗
                          </button>`
                        : nothing
                    }
                    <button
                      class="mermaid-control-button"
                      @click=${this._zoomIn}
                      title="Zoom in"
                    >
                      +
                    </button>
                    <button
                      class="mermaid-control-button"
                      @click=${this._zoomOut}
                      title="Zoom out"
                    >
                      −
                    </button>
                    <button
                      class="mermaid-control-button"
                      @click=${this._resetTransform}
                      title="Reset view"
                    >
                      ⟳
                    </button>
                  </div>
                  <div class="mermaid-scale-info">
                    ${Math.round(this.scale * 100)}%
                  </div>
                `
              : nothing
          }
        </div>
      </div>
    `;
  }
}

export function effects() {
  customElements.define("mermaid-preview", MermaidPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    "mermaid-preview": MermaidPreview;
  }
}
