import { CloseIcon, DoneIcon } from "@myoxus/icons/lit";
import track from "@myoxus/track";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

import type { PatchOp } from "../../utils/apply-model/markdown-diff";

export class BlockDiffOptions extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      position: absolute;
      right: calc(
        ${unsafeCSSValue(
          "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
        )} *
          -1
      );
      top: 0;

      display: flex;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      cursor: pointer;
      pointer-events: auto;
    }

    .ai-block-diff-option {
      padding: ${unsafeCSSValue("var(--mantine-spacing-2xs)")};
      border-radius: ${unsafeCSSValue("var(--mantine-radius-sm)")};
      box-shadow: ${unsafeCSSValue("var(--mantine-shadow-sm)")};
      display: flex;
      background-color: ${unsafeCSSVar("backgroundOverlayPanelColor")};
      align-items: center;
      justify-content: center;
    }

    .ai-block-diff-option.accept {
      color: ${unsafeCSSVar("primaryColor")};
    }

    .ai-block-diff-option.reject {
      color: ${unsafeCSSVar("iconSecondary")};
    }
  `;

  @property({ attribute: false })
  accessor onAccept!: (op: PatchOp) => void;

  @property({ attribute: false })
  accessor op!: PatchOp;

  @property({ attribute: false })
  accessor onReject!: (op: PatchOp) => void;

  private readonly _handleAcceptClick = () => {
    track.applyModel.widget.block.accept();
    this.onAccept(this.op);
  };

  private readonly _handleRejectClick = () => {
    track.applyModel.widget.block.reject();
    this.onReject(this.op);
  };

  override render() {
    return html`
      <div
        class="ai-block-diff-option accept"
        @click=${this._handleAcceptClick}
      >
        ${DoneIcon()}
      </div>
      <div
        class="ai-block-diff-option reject"
        @click=${this._handleRejectClick}
      >
        ${CloseIcon()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-block-diff-options": BlockDiffOptions;
  }
}
