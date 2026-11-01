import { WithDisposable } from "@virgultum/editor/global/lit";
import { fontXSStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue } from "@virgultum/editor/shared/theme";
import type { EditorHost } from "@virgultum/editor/std";
import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";

import type { AIPanelAnswerConfig, CopyConfig } from "../../type.js";
import { filterAIItemGroup } from "../../utils.js";

export class AIPanelAnswer extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      width: 100%;
      display: flex;
      box-sizing: border-box;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      padding: 0;
    }

    .answer {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: flex-start;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
      align-self: stretch;
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-md)")};
    }

    .answer-head {
      align-self: stretch;

      color: var(--myoxus-text-secondary-color);
    }

    .answer-body {
      align-self: stretch;

      color: var(--myoxus-text-primary-color);
    }

    .response-list-container {
      display: flex;
      flex-direction: column;
      gap: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    }

    .response-list-container,
    .action-list-container {
      padding: 0 ${unsafeCSSValue("var(--mantine-spacing-sm)")};
      user-select: none;
    }

    /* set item style outside ai-item */
    .response-list-container ai-item-list,
    .action-list-container ai-item-list {
      --item-padding: ${unsafeCSSValue("var(--mantine-spacing-xs)")};
    }

    .response-list-container ai-item-list {
    }

    ${fontXSStyle(".answer-head")}
    ${fontXSStyle(".answer-body")}
  `;

  override render() {
    const responseGroup = filterAIItemGroup(this.host, this.config.responses);
    return html`
      <div class="answer">
        <div class="answer-head">Answer</div>
        <div class="answer-body" data-testid="answer-content">
          <slot></slot>
        </div>
      </div>
      ${
        this.finish
          ? html`
              <ai-finish-tip
                .copy=${this.copy}
                .host=${this.host}
              ></ai-finish-tip>
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
                          <div
                            class="response-list-container"
                            data-testid=${group.testId}
                          >
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
              ${
                responseGroup.length > 0 && this.config.actions.length > 0
                  ? html`<ai-panel-divider></ai-panel-divider>`
                  : nothing
              }
              ${
                this.config.actions.length > 0
                  ? html`
                      <div class="action-list-container">
                        <ai-item-list
                          .host=${this.host}
                          .groups=${this.config.actions}
                        ></ai-item-list>
                      </div>
                    `
                  : nothing
              }
            `
          : nothing
      }
    `;
  }

  @property({ attribute: false })
  accessor config!: AIPanelAnswerConfig;

  @property({ attribute: false })
  accessor copy: CopyConfig | undefined = undefined;

  @property({ attribute: false })
  accessor finish = true;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: "data-testid", reflect: true })
  accessor testId = "ai-penel-answer";
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-panel-answer": AIPanelAnswer;
  }
}
