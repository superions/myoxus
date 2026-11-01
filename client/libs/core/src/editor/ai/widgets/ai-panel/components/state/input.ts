import { SendIcon } from "@myoxus/icons/lit";
import { AIStarIcon } from "@virgultum/editor/components/icons";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { stopPropagation } from "@virgultum/editor/shared/utils";
import { css, html, LitElement, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";

export class AIPanelInput extends SignalWatcher(WithDisposable(LitElement)) {
  static override styles = css`
    :host {
      width: 100%;
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-md)")};
      box-sizing: border-box;
    }

    .root {
      display: flex;
      align-items: flex-start;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
    }

    .star {
      display: flex;
      padding: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
      align-items: center;
    }

    .textarea-container {
      display: flex;
      align-items: flex-end;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      flex: 1 0 0;

      textarea {
        flex: 1 0 0;
        border: none;
        outline: none;
        -webkit-box-shadow: none;
        -moz-box-shadow: none;
        box-shadow: none;
        background-color: transparent;
        resize: none;
        overflow: hidden;
        padding: 0;

        color: ${unsafeCSSVar("textPrimaryColor")};
      }

      textarea::placeholder {
        color: ${unsafeCSSVar("placeholderColor")};
      }

      textarea::-moz-placeholder {
        color: ${unsafeCSSVar("placeholderColor")};
      }
    }

    .arrow {
      display: flex;
      align-items: center;
      padding: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      background: ${unsafeCSSVar("textDisableColor")};
      svg {
        width: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
        height: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
        color: ${unsafeCSSVar("pureWhite")};
      }
    }

    .arrow[data-active="true"] {
      background: ${unsafeCSSVar("primaryColor")};
    }

    .arrow[data-active="true"]:hover {
      cursor: pointer;
    }

    .network {
      display: flex;
      align-items: center;
      padding: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      cursor: pointer;
      svg {
        width: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
        height: ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )};
        color: ${unsafeCSSVar("iconColor")};
      }
    }

    .network[data-active="true"] svg {
      color: ${unsafeCSSVar("primaryColor")};
    }

    ${fontSMStyle("textarea")}
  `;

  private readonly _onInput = () => {
    this.textarea.style.height = "auto";
    this.textarea.style.height = this.textarea.scrollHeight + "px";

    this.onInput?.(this.textarea.value);
    const value = this.textarea.value.trim();
    this._hasContent = value.length > 0;
    this._arrow.dataset.active = String(this._hasContent);
  };

  private readonly _onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      this._sendToAI(e);
    }
  };

  private readonly _sendToAI = (e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const value = this.textarea.value.trim();
    if (value.length === 0) return;

    this.onFinish?.(value);
    this.remove();
  };

  override render() {
    return html`<div class="root">
      <div class="star">${AIStarIcon}</div>
      <div class="textarea-container">
        <textarea
          placeholder="What are your thoughts?"
          rows="1"
          @keydown=${this._onKeyDown}
          @input=${this._onInput}
          @pointerdown=${stopPropagation}
          @click=${stopPropagation}
          @dblclick=${stopPropagation}
          @cut=${stopPropagation}
          @copy=${stopPropagation}
          @paste=${stopPropagation}
          @keyup=${stopPropagation}
        ></textarea>
        <div
          class="arrow"
          data-testid="ai-panel-input-send"
          @click=${this._sendToAI}
          @pointerdown=${stopPropagation}
        >
          ${SendIcon()}
          ${
            this._hasContent
              ? html`<myoxus-tooltip>Send to AI</myoxus-tooltip>`
              : nothing
          }
        </div>
      </div>
    </div>`;
  }

  override updated(_changedProperties: Map<PropertyKey, unknown>): void {
    const result = super.updated(_changedProperties);
    this.textarea.style.height = this.textarea.scrollHeight + "px";
    return result;
  }

  @query(".arrow")
  private accessor _arrow!: HTMLDivElement;

  @state()
  private accessor _hasContent = false;

  @property({ attribute: false })
  accessor onFinish: ((input: string) => void) | undefined = undefined;

  @property({ attribute: false })
  accessor onInput: ((input: string) => void) | undefined = undefined;

  @query("textarea")
  accessor textarea!: HTMLTextAreaElement;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-panel-input": AIPanelInput;
  }
}
