import { CodeBlockPreviewExtension } from "@virgultum/editor/blocks/code";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import type { CodeBlockModel } from "@virgultum/editor/model";
import {
  EditorChromeHostIdentifier,
  type RenderCodePreviewStatus,
} from "@virgultum/editor/shared/services";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { ShadowlessElement } from "@virgultum/core/runtime";
import { css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

import { ensureTypstReady, getTypst } from "./typst";

const RENDER_DEBOUNCE_MS = 200;

export const CodeBlockTypstPreview = CodeBlockPreviewExtension(
  "typst",
  (model, block) => {
    const preview = block.ownerDocument.createElement("typst-preview");
    preview.model = model;
    preview.renderStatus = block.std.get(
      EditorChromeHostIdentifier,
    ).renderCodePreviewStatus;

    return preview;
  },
);

export class TypstPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    ${fontSMStyle(".typst-control-button")}

    .typst-preview-container {
      width: 100%;
      min-height: ${unsafeCSSValue("320px")};
      max-height: calc(
        ${unsafeCSSValue("456px")} +
          ${unsafeCSSValue("calc(var(--mantine-spacing-2xl) * 2)")} +
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
          )}
      );
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      overflow: auto;
      position: relative;
      cursor: grab;
    }

    .typst-preview-svg {
      width: 100%;
      transform-origin: center;
      transition: transform ${unsafeCSSValue("120ms")} ease-out;
      display: inline-block;
    }

    .typst-preview-svg > div {
      display: flex;
      justify-content: center;
      width: 100%;
      transform-origin: center;
    }

    .typst-controls {
      position: absolute;
      top: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      right: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      display: flex;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      z-index: var(--myoxus-z-index-popover);
    }

    .typst-control-button {
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
      )};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      color: ${unsafeCSSVar("textPrimaryColor")};
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition:
        background ${unsafeCSSValue("200ms")} ease,
        border-color ${unsafeCSSValue("200ms")} ease,
        transform ${unsafeCSSValue("120ms")} ease;
    }

    .typst-control-button:hover {
      background: ${unsafeCSSVar("hoverColor")};
      border-color: ${unsafeCSSVar("primaryColor")};
    }

    .typst-control-button:active {
      transform: scale(0.96);
    }
  `;

  @property({ attribute: false })
  accessor renderStatus!: RenderCodePreviewStatus;

  @property({ attribute: false })
  accessor model: CodeBlockModel | null = null;

  @property({ attribute: false })
  accessor typstCode: string | null = null;

  @state()
  accessor state: "loading" | "error" | "finish" | "fallback" | "syntax-error" =
    "loading";

  @state()
  accessor svgContent: string = "";

  @state()
  accessor errorMessage: string | null = null;

  @state()
  accessor copyState: "idle" | "copied" | "failed" = "idle";

  @query(".typst-preview-container")
  accessor container!: HTMLDivElement;

  private renderTimeout: ReturnType<typeof setTimeout> | null = null;
  private isRendering = false;
  private copyTimeout: ReturnType<typeof setTimeout> | undefined;
  private scale = 1;
  private translateX = 0;
  private translateY = 0;
  private isDragging = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  private async _copyError() {
    if (!this.errorMessage) return;
    try {
      await navigator.clipboard.writeText(this.errorMessage);
      if (!this.isConnected) return;
      this.copyState = "copied";
    } catch (err) {
      console.error("Failed to copy Typst error message:", err);
      if (!this.isConnected) return;
      this.copyState = "failed";
    }
    clearTimeout(this.copyTimeout);
    this.copyTimeout = setTimeout(() => (this.copyState = "idle"), 1500);
  }

  private get _finalPreview() {
    return this.state === "finish"
      ? html`
          <div class="typst-controls">
            <button
              class="typst-control-button"
              @click=${this._zoomOut}
              title="Zoom out"
            >
              −
            </button>
            <button
              class="typst-control-button"
              @click=${this._resetView}
              title="Reset view"
            >
              ⟳
            </button>
            <button
              class="typst-control-button"
              @click=${this._zoomIn}
              title="Zoom in"
            >
              +
            </button>
          </div>
          <div
            class="typst-preview-svg"
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
        `
      : nothing;
  }

  override firstUpdated() {
    this._scheduleRender();
    this._setupDragListeners();

    if (this.model) {
      this.disposables.add(
        this.model.props.text$.subscribe(() => {
          this._scheduleRender();
        }),
      );
    }
  }

  override disconnectedCallback(): void {
    clearTimeout(this.copyTimeout);
    this.copyState = "idle";
    super.disconnectedCallback();
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
  }

  get normalizedCode() {
    return this.model?.props.text.toString() ?? this.typstCode ?? "";
  }

  private _scheduleRender() {
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
    }

    this.renderTimeout = setTimeout(() => {
      this._render().catch((error) => {
        console.error("Typst preview render failed:", error);
      });
    }, RENDER_DEBOUNCE_MS);
  }

  private _resetView() {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.requestUpdate();
  }

  private _zoomIn() {
    this.scale = Math.min(this.scale * 1.2, 5);
    this.requestUpdate();
  }

  private _zoomOut() {
    this.scale = Math.max(this.scale / 1.2, 0.2);
    this.requestUpdate();
  }

  private _setupDragListeners() {
    if (!this.container) return;

    this.disposables.addFromEvent(
      this.container,
      "mousedown",
      (event: MouseEvent) => {
        if (event.button !== 0) return;
        this.isDragging = true;
        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;
        this.container.style.cursor = "grabbing";
      },
    );

    this.disposables.addFromEvent(
      document,
      "mousemove",
      (event: MouseEvent) => {
        if (!this.isDragging) return;
        const deltaX = event.clientX - this.lastMouseX;
        const deltaY = event.clientY - this.lastMouseY;

        this.translateX += deltaX;
        this.translateY += deltaY;
        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;
        this.requestUpdate();
      },
    );

    this.disposables.addFromEvent(document, "mouseup", () => {
      this.isDragging = false;
      if (this.container) {
        this.container.style.cursor = "grab";
      }
    });

    this.disposables.addFromEvent(this.container, "selectstart", (e) =>
      e.preventDefault(),
    );
  }

  private async _render() {
    if (this.isRendering) return;
    this.isRendering = true;
    this.state = "loading";
    this.errorMessage = null;

    const code = this.normalizedCode.trim();
    if (!code) {
      this.svgContent = "";
      this.state = "fallback";
      this.isRendering = false;
      return;
    }

    try {
      await ensureTypstReady();
      const typst = await getTypst();
      const svg = await typst.svg({ mainContent: code });
      this.svgContent = svg;
      this.state = "finish";
      this._resetView();
    } catch (error) {
      console.error("Typst preview failed:", error);
      const message =
        (error as Error | undefined)?.message ??
        (typeof error === "string" ? error : null);
      this.errorMessage = message;
      this.state =
        message && message.toLowerCase().includes("syntax")
          ? "syntax-error"
          : "error";
    } finally {
      this.isRendering = false;
    }
  }

  override render() {
    return html`
      <div class="typst-preview-wrapper">
        ${
          this.state === "finish"
            ? nothing
            : this.renderStatus({
                language: "Typst",
                state:
                  this.state === "fallback"
                    ? "empty"
                    : this.state === "loading"
                      ? "loading"
                      : "error",
                detail: this.errorMessage,
                fontError: this.errorMessage
                  ?.toLowerCase()
                  .includes("no font could be found"),
                copyState: this.copyState,
                copy: () => {
                  void this._copyError();
                },
              })
        }
        <div
          class="typst-preview-container"
          style=${styleMap({
            display: this.state === "finish" ? undefined : "none",
          })}
        >
          ${this._finalPreview}
        </div>
      </div>
    `;
  }
}

export function effects() {
  customElements.define("typst-preview", TypstPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    "typst-preview": TypstPreview;
  }
}
