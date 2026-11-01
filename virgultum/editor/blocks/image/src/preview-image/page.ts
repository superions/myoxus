import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { ImageIcon } from "@myoxus/icons/lit";
import type { ImageBlockModel } from "@virgultum/model";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import { BlockComponent } from "@virgultum/std";
import { css, html } from "lit";

export class ImagePlaceholderBlockComponent extends BlockComponent<ImageBlockModel> {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  static override styles = css`
    .myoxus-placeholder-preview-container {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      padding: 4px;
      box-sizing: border-box;

      border-radius: 8px;
      background-color: ${unsafeCSSVar("backgroundOverlayPanelColor")};
    }

    .placeholder-preview-content {
      padding: 4px 16px;
      display: flex;
      gap: 8px;
    }

    .placeholder-preview-content > svg {
      color: ${unsafeCSSVar("iconColor")};
    }

    .placeholder-preview-content > .text {
      color: var(--myoxus-text-primary-color);
      color: ${unsafeCSSVar("textPrimaryColor")};
      font-size: 14px;
      line-height: 24px;
    }
  `;

  override renderBlock() {
    return html`<div
      class="myoxus-placeholder-preview-container"
      contenteditable="false"
    >
      <div class="placeholder-preview-content">
        ${ImageIcon({ width: "24px", height: "24px" })}
        <span class="text"
          >${this._text(editorMessage("com.myoxus.editor.drag.image-block", "Image Block"))}</span
        >
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-placeholder-preview-image": ImagePlaceholderBlockComponent;
  }
}
