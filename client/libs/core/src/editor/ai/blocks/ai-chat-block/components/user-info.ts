import { fontSMStyle } from "@virgultum/editor/shared/styles";
import { unsafeCSSValue, unsafeCSSVar } from "@virgultum/editor/shared/theme";
import { css, html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

import type {
  MessageRole,
  MessageUserInfo,
} from "../../../components/ai-chat-messages";
import { MyoxusAIIcon } from "./icon";

export class UserInfo extends LitElement {
  static override styles = css`
    .user-info-container {
      display: flex;
      width: 100%;
      min-height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
      flex-direction: row;
      gap: ${unsafeCSSValue(
        "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))",
      )};

      .user-avatar-container {
        width: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
        height: ${unsafeCSSValue("var(--mantine-spacing-xl)")};
        color: ${unsafeCSSVar("textEmphasisColor")};
        display: flex;
        justify-content: center;
        align-items: center;
      }

      .default-avatar,
      .user-avatar-container img {
        width: 100%;
        height: 100%;
        border-radius: 50%;
      }

      .user-avatar-container img {
        object-fit: cover;
      }

      .default-avatar,
      .avatar-image {
        background-color: ${unsafeCSSVar("textEmphasisColor")};
      }

      .user-name {
        color: ${unsafeCSSVar("textPrimaryColor")};
        text-align: justify;
        text-overflow: ellipsis;
      }
    }

    ${fontSMStyle(".user-name")}
  `;

  private _handleAvatarLoadError(e: Event) {
    const target = e.target as HTMLImageElement;
    target.onerror = null;
    this.avatarLoadedFailed = true;
  }

  override render() {
    return html`<div class="user-info-container">
      <div class="user-avatar-container">
        ${
          this.avatarIcon
            ? this.avatarIcon
            : this.avatarUrl && !this.avatarLoadedFailed
              ? html`<img
                  .src=${this.avatarUrl}
                  @error=${this._handleAvatarLoadError}
                />`
              : html`<span class="default-avatar"></span>`
        }
      </div>
      <span class="user-name">${this.userName}</span>
    </div>`;
  }

  @property({ attribute: false })
  accessor avatarIcon: TemplateResult<1> | undefined = undefined;

  @property({ attribute: false })
  accessor avatarLoadedFailed = false;

  @property({ attribute: false })
  accessor avatarUrl: string | undefined = undefined;

  @property({ attribute: false })
  accessor userName!: string;
}

declare global {
  interface HTMLElementTagNameMap {
    "user-info": UserInfo;
  }
}

export function UserInfoTemplate(
  userInfo: MessageUserInfo,
  messageRole?: MessageRole,
) {
  const isUser = !!messageRole && messageRole === "user";

  const userInfoTemplate = isUser
    ? html`<user-info
        .userName=${userInfo.userName ?? "You"}
        .avatarUrl=${userInfo.avatarUrl}
      ></user-info>`
    : html`<user-info
        .userName=${"Myoxus AI"}
        .avatarIcon=${MyoxusAIIcon}
      ></user-info>`;

  return userInfoTemplate;
}
