import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { SignalWatcher } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { scrollbarStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { createElement } from "react";
import { ChatImagePreviewView } from "./ai-chat-chips/view";

export class ImagePreviewGrid extends SignalWatcher(ShadowlessElement) {
  @property({ attribute: false })
  accessor reactToLit!: ReactToLit;
  static override styles = css`
    image-preview-grid .image-preview-wrapper {
      overflow-x: auto;
      overflow-y: hidden;
      max-block-size: calc(
        ${unsafeCSSValue("calc(var(--mantine-spacing-2xl) * 2)")} +
          ${unsafeCSSValue("var(--mantine-spacing-lg)")}
      );
      white-space: nowrap;
    }

    ${scrollbarStyle("image-preview-grid .image-preview-wrapper")}

    image-preview-grid .images-container {
      display: flex;
      flex-direction: row;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      flex-wrap: nowrap;
      position: relative;
    }

    image-preview-grid .image-container {
      inline-size: calc(
        ${unsafeCSSValue("calc(var(--mantine-spacing-2xl) * 2)")} +
          ${unsafeCSSValue("var(--mantine-spacing-xs)")}
      );
      block-size: calc(
        ${unsafeCSSValue("calc(var(--mantine-spacing-2xl) * 2)")} +
          ${unsafeCSSValue("var(--mantine-spacing-xs)")}
      );
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      cursor: pointer;
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      flex: 0 0 auto;
      border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
      overflow: hidden;
    }

    image-preview-grid .image-preview {
      inline-size: 100%;
      block-size: 100%;
      /* Input previews must not crop away content the model will receive. */
      object-fit: contain;
    }
  `;

  private readonly _urlMap = new Map<string, string>();

  private _getFileKey(file: File) {
    return `${file.name}-${file.size}-${file.lastModified}`;
  }

  private _disposeUrls() {
    for (const url of this._urlMap.values()) {
      URL.revokeObjectURL(url);
    }
    this._urlMap.clear();
  }

  /**
   * Returns a stable object URL while the preview item is mounted.
   *
   * Rendering can run repeatedly, so object URL ownership stays keyed by file
   * identity instead of reference-counting every render pass.
   */
  private _getObjectUrl(file: File) {
    const key = this._getFileKey(file);
    let url = this._urlMap.get(key);

    if (!url) {
      url = URL.createObjectURL(file);
      this._urlMap.set(key, url);
    }

    return url;
  }

  private readonly _releaseObjectUrlForFile = (file: File) => {
    const key = this._getFileKey(file);
    const url = this._urlMap.get(key);

    if (url) {
      URL.revokeObjectURL(url);
      this._urlMap.delete(key);
    }
  };

  private readonly _handleDelete = (index: number) => {
    const file = this.images[index];
    this._releaseObjectUrlForFile(file);
    this.onImageRemove?.(index);
  };

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._disposeUrls();
  }

  override render() {
    if (!this.reactToLit) return nothing;
    return html`
      <div class="image-preview-wrapper">
        <div class="images-container">
          ${repeat(
            this.images,
            (image) => this._getFileKey(image),
            (image, index) => {
              const url = this._getObjectUrl(image);
              return this.reactToLit(
                createElement(ChatImagePreviewView, {
                  name: image.name,
                  onRemove: () => this._handleDelete(index),
                  preview: toReactNode(html`
                    <div class="image-container">
                      <img
                        class="image-preview"
                        src=${url}
                        alt=""
                        @error=${() => this._releaseObjectUrlForFile(image)}
                      />
                    </div>
                  `),
                }),
                true,
              );
            },
          )}
        </div>
      </div>
    `;
  }

  @property({ type: Array })
  accessor images: File[] = [];

  @property({ attribute: false })
  accessor onImageRemove: ((index: number) => void) | null = null;
}

declare global {
  interface HTMLElementTagNameMap {
    "image-preview-grid": ImagePreviewGrid;
  }
}
