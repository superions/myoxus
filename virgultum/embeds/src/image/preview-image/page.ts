import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { ImageIcon } from "@myoxus/icons/native";
import type { ImageBlockModel } from "@virgultum/core/models";
import {
  installEditorStyles,
  NativeBlockComponent,
} from "@virgultum/core/runtime";

const imagePlaceholderStyles = `
  .myoxus-placeholder-preview-container {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 4px;
    box-sizing: border-box;

    border-radius: 8px;
    background-color: var(--myoxus-background-overlay-panel-color);
  }

  .placeholder-preview-content {
    padding: 4px 16px;
    display: flex;
    gap: 8px;
  }

  .placeholder-preview-content > svg {
    color: var(--myoxus-icon-color);
  }

  .placeholder-preview-content > .text {
    color: var(--myoxus-text-primary-color);
    font-size: 14px;
    line-height: 24px;
  }
`;

export class ImagePlaceholderBlockComponent extends NativeBlockComponent<ImageBlockModel> {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  override requestUpdate() {}

  connectedCallback() {
    if (!this.connectBlock()) return;
    installEditorStyles(this, imagePlaceholderStyles);

    const doc = this.ownerDocument;
    const container = doc.createElement("div");
    container.className = "myoxus-placeholder-preview-container";
    container.contentEditable = "false";

    const content = doc.createElement("div");
    content.className = "placeholder-preview-content";

    const template = doc.createElement("template");
    template.innerHTML = ImageIcon;
    const icon = template.content.firstElementChild as SVGSVGElement | null;
    if (icon) {
      icon.setAttribute("width", "24px");
      icon.setAttribute("height", "24px");
      content.append(icon);
    }

    const label = doc.createElement("span");
    label.className = "text";
    label.textContent = this._text(
      editorMessage("com.myoxus.editor.drag.image-block", "Image Block"),
    );
    content.append(label);

    container.append(content);
    this.replaceChildren(container);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.replaceChildren();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-placeholder-preview-image": ImagePlaceholderBlockComponent;
  }
}
