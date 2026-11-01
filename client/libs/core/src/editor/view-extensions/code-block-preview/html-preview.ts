import { CodeBlockPreviewExtension } from "@virgultum/editor/blocks/code";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import type { CodeBlockModel } from "@virgultum/editor/model";
import { fontMonoStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { ShadowlessElement } from "@virgultum/std";
import { css, html, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";
import { styleMap } from "lit/directives/style-map.js";

import { linkIframe } from "./iframe-container";

export const CodeBlockHtmlPreview = CodeBlockPreviewExtension(
  "html",
  (model) => html`<html-preview .model=${model}></html-preview>`,
);

export class HTMLPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    ${fontMonoStyle(".html-preview-loading")}
    ${fontMonoStyle(".html-preview-error")}
    ${fontMonoStyle(".html-preview-fallback")}

    .html-preview-loading {
      color: ${unsafeCSSVar("placeholderColor")};
    }

    .html-preview-error,
    .html-preview-fallback {
      color: ${unsafeCSSVar("errorColor")};
    }

    .html-preview-iframe {
      width: 100%;
      height: calc(
        ${unsafeCSSValue("456px")} +
          ${unsafeCSSValue(
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
          )} +
          ${unsafeCSSValue("var(--mantine-spacing-xl)")}
      );
      border: none;
    }
  `;

  @property({ attribute: false })
  accessor model: CodeBlockModel | null = null;

  @property({ attribute: false })
  accessor html: string | null = null;

  @state()
  accessor state: "loading" | "error" | "finish" | "fallback" = "loading";

  @query("iframe")
  accessor iframe!: HTMLIFrameElement;

  override firstUpdated(_changedProperties: PropertyValues): void {
    const result = super.firstUpdated(_changedProperties);

    this._link();

    if (this.model) {
      this.disposables.add(
        this.model.props.text$.subscribe(() => {
          this._link();
        }),
      );
    }

    return result;
  }

  override updated(changedProperties: PropertyValues): void {
    const result = super.updated(changedProperties);
    if (changedProperties.has("html")) {
      this._link();
    }
    return result;
  }

  get normalizedHtml() {
    return this.model?.props.text.toString() ?? this.html;
  }

  private _link() {
    this.state = "loading";

    if (!this.normalizedHtml) {
      this.state = "fallback";
      return;
    }

    try {
      linkIframe(this.iframe, this.normalizedHtml);
      this.state = "finish";
    } catch (error) {
      console.error("HTML preview iframe failed:", error);
      this.state = "error";
    }
  }

  override render() {
    return html`
      <div class="html-preview-container">
        ${choose(this.state, [
          [
            "loading",
            () =>
              html`<div class="html-preview-loading">
                Rendering the code...
              </div>`,
          ],
          [
            "error",
            () =>
              html`<div class="html-preview-error">
                Failed to render the preview. Please check your HTML code for
                errors.
              </div>`,
          ],
          [
            "fallback",
            () =>
              html`<div class="html-preview-fallback">
                This feature is not supported in your browser. Please download
                the Myoxus Desktop App to use it.
              </div>`,
          ],
        ])}
        <iframe
          class="html-preview-iframe"
          title="HTML Preview"
          style=${styleMap({
            display: this.state === "finish" ? undefined : "none",
          })}
        ></iframe>
      </div>
    `;
  }
}

export function effects() {
  customElements.define("html-preview", HTMLPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    "html-preview": HTMLPreview;
  }
}
