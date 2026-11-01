import {
  AIDoneIcon,
  CopyIcon,
  WarningIcon,
} from "@virgultum/editor/components/icons";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { NotificationProvider } from "@virgultum/editor/shared/services";
import { fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import type { EditorHost } from "@virgultum/editor/std";
import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";

import type { CopyConfig } from "../type.js";

export class AIFinishTip extends WithDisposable(LitElement) {
  static override styles = css`
    .finish-tip {
      display: flex;
      box-sizing: border-box;
      width: 100%;
      min-height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      align-items: center;
      justify-content: space-between;
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-md)")};
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};

      color: var(--myoxus-text-secondary-color);

      .text {
        display: flex;
        align-items: flex-start;
        flex: 1 0 0;
      }

      .right {
        display: flex;
        align-items: center;

        .copy,
        .copied {
          display: flex;
          width: ${unsafeCSSValue(
            "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
          )};
          height: ${unsafeCSSValue(
            "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
          )};
          justify-content: center;
          align-items: center;
          border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
          user-select: none;
        }
        .copy:hover {
          color: var(--myoxus-icon-color);
          background: var(--myoxus-hover-color);
          cursor: pointer;
        }
        .copied {
          color: var(--myoxus-brand-color);
        }
      }
    }

    ${fontXSStyle(".text")}
  `;

  override render() {
    return html`<div class="finish-tip">
      ${WarningIcon}
      <div class="text">AI outputs can be misleading or wrong</div>
      ${
        this.copy?.allowed
          ? html`<div class="right">
              ${
                this.copied
                  ? html`<div class="copied" data-testid="answer-copied">
                      ${AIDoneIcon}
                    </div>`
                  : html`<div
                      class="copy"
                      data-testid="answer-copy-button"
                      @click=${async () => {
                        this.copied = !!(await this.copy?.onCopy());
                        if (this.copied) {
                          this.host.std
                            .getOptional(NotificationProvider)
                            ?.toast("Copied to clipboard");
                        }
                      }}
                    >
                      ${CopyIcon}
                      <myoxus-tooltip>Copy</myoxus-tooltip>
                    </div>`
              }
            </div>`
          : nothing
      }
    </div>`;
  }

  @state()
  accessor copied = false;

  @property({ attribute: false })
  accessor copy: CopyConfig | undefined = undefined;

  @property({ attribute: false })
  accessor host!: EditorHost;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-finish-tip": AIFinishTip;
  }
}
