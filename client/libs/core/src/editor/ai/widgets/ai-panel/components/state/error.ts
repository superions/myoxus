import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontSMStyle, fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import type { EditorHost } from "@virgultum/editor/std";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { choose } from "lit/directives/choose.js";

import { type AIItemGroupConfig } from "../../../../components/ai-item/types.js";
import { AIErrorType } from "../../../../provider";
import type { AIPanelErrorConfig, CopyConfig } from "../../type.js";
import { filterAIItemGroup } from "../../utils.js";

export class AIPanelError extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      padding: 0;
    }

    .error {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: flex-start;
      align-self: stretch;
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-md)")};
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      .answer-tip {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: flex-start;
        gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
        align-self: stretch;
        .answer-label {
          align-self: stretch;
          color: var(--myoxus-text-secondary-color);
        }
      }
      .error-info {
        align-self: stretch;
        color: ${unsafeCSSVar("errorColor")};

        a {
          color: inherit;
        }
      }
      .action-button-group {
        display: flex;
        width: 100%;
        gap: ${unsafeCSSValue("var(--mantine-spacing-lg)")};
        align-items: center;
        justify-content: end;
        margin-top: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      }
      .action-button {
        display: flex;
        box-sizing: border-box;
        padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")}
          ${unsafeCSSValue("var(--mantine-spacing-md)")};
        justify-content: center;
        align-items: center;
        gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
        border-radius: ${unsafeCSSValue("var(--mantine-radius-lg)")};
        border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
          var(--myoxus-border-color);
        background: var(--myoxus-white);
        color: var(--myoxus-text-primary-color);
      }
      .action-button:hover {
        cursor: pointer;
      }
      .action-button.primary {
        border: ${unsafeCSSValue("calc(var(--mantine-scale) * 1px)")} solid
          var(--myoxus-black-10);
        background: var(--myoxus-primary-color);
        color: var(--myoxus-pure-white);
      }
      .action-button > span {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      }
      .action-button:not(.primary):hover {
        background: var(--myoxus-hover-color);
      }
    }

    ai-panel-divider {
      margin-top: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    }

    .response-list-container {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      user-select: none;
    }

    .response-list-container ai-item-list {
      --item-padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    }

    ${fontXSStyle(".answer-label")}
    ${fontSMStyle(".error-info")}
    ${fontXSStyle(".action-button")}
  `;

  private readonly _getResponseGroup = () => {
    let responseGroup: AIItemGroupConfig[] = [];
    const errorType = this.config.error?.type;
    if (errorType && errorType !== AIErrorType.GeneralNetworkError) {
      return responseGroup;
    }

    responseGroup = filterAIItemGroup(this.host, this.config.responses);

    return responseGroup;
  };

  override render() {
    const responseGroup = this._getResponseGroup();
    const errorTemplate = choose(
      this.config.error?.type,
      [
        [
          AIErrorType.Unauthorized,
          () =>
            html` <div class="error-info">
                You need to login to Myoxus Cloud to continue using Myoxus AI.
              </div>
              <div class="action-button-group">
                <div @click=${this.config.cancel} class="action-button">
                  <span>Cancel</span>
                </div>
                <div @click=${this.config.login} class="action-button primary">
                  <span>Login</span>
                </div>
              </div>`,
        ],
        [
          AIErrorType.PaymentRequired,
          () =>
            html` <div class="error-info">
                An unexpected server error occurred. Please try again later.
              </div>
              <div class="action-button-group">
                <div @click=${this.config.cancel} class="action-button">
                  <span>Cancel</span>
                </div>
              </div>`,
        ],
      ],
      // default error handler
      () => {
        const tip = this.config.error?.message;
        const error = tip
          ? html`<span class="error-tip">
              An error occurred
              <myoxus-tooltip tip-position="bottom-start">
                ${tip}
              </myoxus-tooltip>
            </span>`
          : "An error occurred";
        return html`
          <div class="error-info">
            ${error}. Please try again later. If this issue persists, please let
            us know at
            <a
              href=${BUILD_CONFIG.communityUrl}
              target="_blank"
              rel="noreferrer"
            >
              ${BUILD_CONFIG.communityUrl}
            </a>
          </div>
        `;
      },
    );

    return html`
      <div class="error" data-testid="ai-error">
        <div class="answer-tip">
          <div class="answer-label">Answer</div>
          <slot></slot>
        </div>
        ${errorTemplate}
      </div>
      ${
        this.withAnswer
          ? html`<ai-finish-tip
              .copy=${this.copy}
              .host=${this.host}
            ></ai-finish-tip>`
          : nothing
      }
      ${
        responseGroup.length > 0
          ? html`
              <ai-panel-divider></ai-panel-divider>
              ${responseGroup.map(
                (group, index) => html`
                  ${
                    index !== 0
                      ? html`<ai-panel-divider></ai-panel-divider>`
                      : nothing
                  }
                  <div class="response-list-container">
                    <ai-item-list
                      .host=${this.host}
                      .groups=${[group]}
                    ></ai-item-list>
                  </div>
                `,
              )}
            `
          : nothing
      }
    `;
  }

  @property({ attribute: false })
  accessor config!: AIPanelErrorConfig;

  @property({ attribute: false })
  accessor copy: CopyConfig | undefined = undefined;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor withAnswer = false;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-panel-error": AIPanelError;
  }
}
