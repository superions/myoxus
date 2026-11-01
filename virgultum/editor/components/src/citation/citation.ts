import { baseTheme } from "@myoxus/theme";
import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import {
  css,
  html,
  LitElement,
  nothing,
  type TemplateResult,
  unsafeCSS,
} from "lit";
import { property } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

export class CitationCard extends SignalWatcher(WithDisposable(LitElement)) {
  static override styles = css`
    .citation-container {
      width: 100%;
      box-sizing: border-box;
      border-radius: 8px;
      display: flex;
      gap: 2px;
      flex-direction: column;
      align-items: flex-start;
      align-self: stretch;
      padding: 4px 8px;
      background-color: ${unsafeCSSVar("backgroundPrimaryColor")};
      border: 0.5px solid ${unsafeCSSVar("borderColor")};
      font-family: ${unsafeCSS(baseTheme.fontSansFamily)};
      cursor: pointer;
    }

    .citation-header {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;

      .citation-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 16px;
        width: 16px;
        color: ${unsafeCSSVar("iconColor")};
        border-radius: 4px;

        svg,
        img {
          width: 16px;
          height: 16px;
          fill: ${unsafeCSSVar("iconColor")};
        }
      }

      .citation-title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
        line-height: 22px;
        color: ${unsafeCSSVar("textPrimaryColor")};
        font-size: var(--myoxus-font-sm);
        font-weight: 500;
      }

      .citation-identifier {
        display: flex;
        width: 14px;
        height: 14px;
        justify-content: center;
        align-items: center;
        border-radius: 36px;
        background: ${unsafeCSSVar("backgroundSecondaryColor")};
        color: ${unsafeCSSVar("textPrimaryColor")};
        text-align: center;
        font-size: 10px;
        font-style: normal;
        font-weight: 400;
        line-height: 22px; /* 220% */
        transition: background-color 0.3s ease-in-out;
      }
    }

    .citation-container:hover .citation-identifier,
    .citation-identifier.active {
      background: ${unsafeCSSVar("primaryColor")};
      color: ${unsafeCSSVar("pureWhite")};
    }

    .citation-content {
      width: 100%;
      box-sizing: border-box;
      overflow: hidden;
      color: ${unsafeCSSVar("textPrimaryColor")};
      font-feature-settings:
        "liga" off,
        "clig" off;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--myoxus-font-xs);
      font-style: normal;
      font-weight: 400;
      line-height: 20px; /* 166.667% */
    }
  `;

  private readonly _IconTemplate = (icon: TemplateResult | string) => {
    if (typeof icon === "string") {
      return html`<img src="${icon}" alt="favicon" />`;
    }
    return icon;
  };

  override render() {
    const citationIdentifierClasses = classMap({
      "citation-identifier": true,
      active: this.active,
    });
    return html`
      <div
        class="citation-container"
        @click=${this.onClickCallback}
        @dblclick=${this.onDoubleClickCallback}
      >
        <div class="citation-header">
          ${
            this.icon
              ? html`<div class="citation-icon">
                  ${this._IconTemplate(this.icon)}
                </div>`
              : nothing
          }
          <div class="citation-title">${this.citationTitle}</div>
          <div class=${citationIdentifierClasses}>
            ${this.citationIdentifier}
          </div>
        </div>
        ${
          this.citationContent
            ? html`<div class="citation-content">${this.citationContent}</div>`
            : nothing
        }
      </div>
    `;
  }

  @property({ attribute: false })
  accessor icon: TemplateResult | string | undefined = undefined;

  @property({ attribute: false })
  accessor citationTitle: string = "";

  @property({ attribute: false })
  accessor citationContent: string | undefined = undefined;

  @property({ attribute: false })
  accessor citationIdentifier: string = "";

  @property({ attribute: false })
  accessor onClickCallback: ((e: MouseEvent) => void) | undefined = undefined;

  @property({ attribute: false })
  accessor onDoubleClickCallback: ((e: MouseEvent) => void) | undefined =
    undefined;

  @property({ attribute: false })
  accessor active: boolean = false;
}
