import { CodeBlockPreviewExtension } from "@virgultum/editor/blocks/code";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import type { CodeBlockModel } from "@virgultum/editor/model";
import { fontMonoStyle, fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";
import { styleMap } from "lit/directives/style-map.js";

import { ensureTypstReady, getTypst } from "./typst";

const RENDER_DEBOUNCE_MS = 200;

export const CodeBlockTypstPreview = CodeBlockPreviewExtension(
  "typst",
  (model) => html`<typst-preview .model=${model}></typst-preview>`,
);

export class TypstPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    ${fontMonoStyle(".typst-preview-loading")}
    ${fontMonoStyle(".typst-preview-error")}
    ${fontMonoStyle(".typst-preview-fallback")}
    ${fontMonoStyle("details.typst-error-details")}
    ${fontSMStyle(".typst-copy-button")}
    ${fontSMStyle(".typst-control-button")}

    .typst-preview-loading {
      color: ${unsafeCSSVar("placeholderColor")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      text-align: center;
    }

    .typst-preview-error,
    .typst-preview-fallback {
      color: ${unsafeCSSVar("errorColor")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-md)")};
      text-align: center;
    }

    details.typst-error-details {
      margin-top: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      text-align: left;
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} dashed
        ${unsafeCSSVar("borderColor")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-md)")};
      padding: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      background: ${unsafeCSSVar("backgroundSecondaryColor")};
      color: ${unsafeCSSVar("textSecondaryColor")};
    }

    .typst-error-text {
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }

    .typst-copy-row {
      display: flex;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      align-items: center;
      margin-top: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
      )};
    }

    .typst-copy-button {
      min-block-size: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
      )};
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
      background: ${unsafeCSSVar("backgroundPrimaryColor")};
      color: ${unsafeCSSVar("textPrimaryColor")};
      cursor: pointer;
      transition:
        background ${unsafeCSSValue("200ms")} ease,
        border-color ${unsafeCSSValue("200ms")} ease;
    }

    .typst-copy-button:hover {
      background: ${unsafeCSSVar("hoverColor")};
    }

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
      this.copyState = "copied";
      setTimeout(() => (this.copyState = "idle"), 1500);
    } catch (err) {
      console.error("Failed to copy Typst error message:", err);
      this.copyState = "failed";
      setTimeout(() => (this.copyState = "idle"), 1500);
    }
  }

  private get _errorMessageDetail() {
    return this.errorMessage
      ? html`<details class="typst-error-details">
          <summary>Error details</summary>
          <pre
            class="typst-error-text"
            tabindex="0"
            aria-label="Typst error message"
          >
${this.errorMessage}</pre>
          <div class="typst-copy-row">
            <button class="typst-copy-button" @click=${this._copyError}>
              ${this._copyButtonLabel}
            </button>
          </div>
        </details>`
      : nothing;
  }

  private get _errorMessageComponent() {
    const lower = this.errorMessage?.toLowerCase() ?? "";

    const friendlyMessage = lower.includes("no font could be found")
      ? "Failed to load fonts. Please check your network or try again."
      : "Failed to render Typst. Please check your code.";

    return [friendlyMessage, this._errorMessageDetail];
  }

  private get _copyButtonLabel() {
    if (this.copyState === "copied") {
      return "Copied";
    } else if (this.copyState === "failed") {
      return "Copy failed";
    } else {
      return "Copy";
    }
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
        ${choose(this.state, [
          [
            "loading",
            () =>
              html`<div class="typst-preview-loading">
                Rendering Typst code...
              </div>`,
          ],
          [
            "error",
            () =>
              html`<div class="typst-preview-error">
                ${this._errorMessageComponent}
              </div>`,
          ],
          [
            "syntax-error",
            () =>
              html`<div class="typst-preview-error">
                Typst code has errors: ${this.errorMessage ?? "Unknown error."}
                ${this._errorMessageDetail}
              </div>`,
          ],
          [
            "fallback",
            () =>
              html`<div class="typst-preview-fallback">
                Enter Typst code to preview.
              </div>`,
          ],
        ])}
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
