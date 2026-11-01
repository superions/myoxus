import { CloseIcon } from "@myoxus/icons/lit";
import { fontWebStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { ShadowlessElement } from "@virgultum/editor/std";
import { css, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

/**
 * A modal component for AI Playground
 */
export class PlaygroundModal extends ShadowlessElement {
  static override styles = css`
    playground-modal {
      position: fixed;
      inset: 0;
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: var(--myoxus-z-index-modal);
      box-sizing: border-box;
      padding: ${unsafeCSSValue("var(--mantine-spacing-md)")}
        ${unsafeCSSValue("var(--mantine-spacing-lg)")};
      background-color: ${unsafeCSSVar("backgroundModalColor")};
    }

    .playground-modal-container {
      position: relative;
      inline-size: 100%;
      max-inline-size: ${unsafeCSSValue("100rem")};
      block-size: 100%;
      max-block-size: 100%;
      background-color: ${unsafeCSSVar("backgroundPrimaryColor")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-xl)")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .playground-modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: ${unsafeCSSValue("var(--mantine-spacing-lg)")}
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
      border-bottom: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
        ${unsafeCSSVar("borderColor")};
    }

    .playground-modal-title {
      color: ${unsafeCSSVar("textPrimaryColor")};
    }

    .playground-modal-close {
      appearance: none;
      border: none;
      background-color: transparent;
      color: ${unsafeCSSVar("iconSecondary")};
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      width: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs))",
      )};
      height: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs))",
      )};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
    }

    .playground-modal-close:hover {
      background-color: ${unsafeCSSVar("hoverColor")};
    }

    .playground-modal-close:focus-visible {
      outline: none;
      box-shadow: ${unsafeCSSValue(
        "0px 0px 0px 2px\n    color-mix(in srgb, var(--myoxus-accent-primary) 30%, transparent)",
      )};
    }

    .playground-modal-content {
      flex: 1;
      overflow-y: auto;
    }

    ${fontWebStyle(".playground-modal-title", "card-title")}
  `;

  private _close() {
    this.remove();
    this.onClose?.();
  }

  private readonly _handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      this._close();
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._handleKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._handleKeyDown);
  }

  override render() {
    return html`
      <div class="playground-modal-container">
        <div class="playground-modal-header">
          <div class="playground-modal-title">${this.modalTitle}</div>
          <button
            aria-label="Close AI Playground"
            @click="${this._close}"
            class="playground-modal-close"
            type="button"
          >
            ${CloseIcon()}
          </button>
        </div>
        <div class="playground-modal-content">${this.content}</div>
      </div>
    `;
  }

  @property({ attribute: false })
  accessor modalTitle: string = "";

  @property({ attribute: false })
  accessor content: TemplateResult = html`
    <div>Welcome to the AI Playground!</div>
  `;

  @property({ attribute: false })
  accessor onClose: (() => void) | undefined = undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "playground-modal": PlaygroundModal;
  }
}

/**
 * Creates and displays a modal with the provided content
 */
export const createPlaygroundModal = (
  content: TemplateResult,
  title: string,
) => {
  // Create the modal element
  const modal = document.createElement("playground-modal") as PlaygroundModal;
  modal.modalTitle = title;
  modal.content = content;

  // Add the modal to the document body
  document.body.append(modal);

  return modal;
};
