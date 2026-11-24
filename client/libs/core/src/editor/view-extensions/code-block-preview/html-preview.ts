import { CodeBlockPreviewExtension } from "@virgultum/editor/blocks/code";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import type { CodeBlockModel } from "@virgultum/editor/model";
import {
  EditorChromeHostIdentifier,
  type RenderCodePreviewStatus,
} from "@virgultum/editor/shared/services";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import { ShadowlessElement } from "@virgultum/core/runtime";
import { css, html, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";

import { linkIframe } from "./iframe-container";

export const CodeBlockHtmlPreview = CodeBlockPreviewExtension(
  "html",
  (model, block) => {
    const preview = block.ownerDocument.createElement("html-preview");
    preview.model = model;
    preview.renderStatus = block.std.get(
      EditorChromeHostIdentifier,
    ).renderCodePreviewStatus;

    return preview;
  },
);

export class HTMLPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
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
  accessor renderStatus!: RenderCodePreviewStatus;

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
        ${this.state === "finish" ? undefined : this.renderStatus({ language: "HTML", state: this.state === "fallback" ? "empty" : this.state })}
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
