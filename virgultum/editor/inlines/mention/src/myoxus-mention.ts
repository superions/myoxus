import { SignalWatcher, WithDisposable } from "@virgultum/global/lit";
import { UserProvider } from "@virgultum/shared/services";
import { unsafeCSSVar } from "@virgultum/shared/theme";
import type { MyoxusTextAttributes } from "@virgultum/shared/types";
import { type BlockStdScope, ShadowlessElement } from "@virgultum/std";
import {
  ZERO_WIDTH_FOR_EMBED_NODE,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/std/inline";
import type { DeltaInsert } from "@virgultum/store";
import { css, html } from "lit";
import { property } from "lit/decorators.js";

export class MyoxusMention extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  static override styles = css`
    .myoxus-mention {
      color: ${unsafeCSSVar("textPrimaryColor")};
      font-feature-settings:
        "liga" off,
        "clig" off;
      /* Client/baseMedium */
      font-family: Inter;
      font-size: var(--myoxus-font-size-base);
      font-style: normal;
      font-weight: 500;
      line-height: 24px; /* 160% */
      padding: 0 4px;
      border-radius: 4px;
      user-select: none;
    }
    .myoxus-mention:hover {
      background: var(--myoxus-hover-color);
    }
    .myoxus-mention[data-selected="true"] {
      background: var(--myoxus-hover-color);
    }
    .myoxus-mention[data-type="default"] {
      color: ${unsafeCSSVar("textPrimaryColor")};
    }
    .myoxus-mention[data-type="removed"] {
      color: ${unsafeCSSVar("textDisableColor")};
    }
    .myoxus-mention[data-type="error"] {
      color: ${unsafeCSSVar("textDisableColor")};
    }
    .myoxus-mention[data-type="loading"] {
      color: ${unsafeCSSVar("placeholderColor")};
      background: ${unsafeCSSVar("backgroundTertiaryColor")};
    }
    .loading-text {
      display: inline-block;
    }
    .dots {
      display: inline-block;
    }
    .dot {
      display: inline-block;
      opacity: 0;
      animation: pulse 1.2s infinite;
    }
    .dots > .dot:nth-child(2) {
      animation-delay: 0.4s;
    }
    .dots > .dot:nth-child(3) {
      animation-delay: 0.8s;
    }
    @keyframes pulse {
      0% {
        opacity: 0;
      }
      33.333% {
        opacity: 1;
      }
      66.666% {
        opacity: 1;
      }
      100% {
        opacity: 0;
      }
    }
  `;

  override render() {
    const errorContent = html`<span
      data-selected=${this.selected}
      data-type="error"
      class="myoxus-mention"
      >@Unknown Member<v-text .str=${ZERO_WIDTH_FOR_EMBED_NODE}></v-text
    ></span>`;

    const userService = this.std.getOptional(UserProvider);
    const memberId = this.delta.attributes?.mention?.member;
    if (!userService || !memberId) {
      return errorContent;
    }

    userService.revalidateUserInfo(memberId);
    const isLoading$ = userService.isLoading$(memberId);
    const userInfo$ = userService.userInfo$(memberId);

    if (userInfo$.value) {
      if (userInfo$.value.removed) {
        return html`<span
          data-selected=${this.selected}
          data-type="removed"
          class="myoxus-mention"
          >@Inactive Member<v-text .str=${ZERO_WIDTH_FOR_EMBED_NODE}></v-text
        ></span>`;
      } else {
        return html`<span
          data-selected=${this.selected}
          data-type="default"
          class="myoxus-mention"
          >@${userInfo$.value.name ?? "Unknown"}<v-text
            .str=${ZERO_WIDTH_FOR_EMBED_NODE}
          ></v-text
        ></span>`;
      }
    }

    if (isLoading$.value) {
      return html`<span
        data-selected=${this.selected}
        data-type="loading"
        class="myoxus-mention"
        >@loading<span class="dots"
          ><span class="dot">.</span><span class="dot">.</span
          ><span class="dot">.</span></span
        ><v-text .str=${ZERO_WIDTH_FOR_EMBED_NODE}></v-text
      ></span>`;
    }

    return errorContent;
  }

  @property({ type: Object })
  accessor delta: DeltaInsert<MyoxusTextAttributes> = {
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
    attributes: {},
  };

  @property({ type: Boolean })
  accessor selected = false;

  @property({ attribute: false })
  accessor std!: BlockStdScope;
}
