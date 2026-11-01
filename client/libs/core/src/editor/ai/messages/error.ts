// SPDX-License-Identifier: MIT
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import { type EditorHost, ShadowlessElement } from "@virgultum/editor/std";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";
import { chatI18n } from "../components/chat-i18n";
import {
  type AIError,
  AIProvider,
  GeneralNetworkError,
  UnauthorizedError,
} from "../provider";
import { ChatErrorView } from "./error-view";

export class AIErrorWrapper extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
  @property({ attribute: false }) accessor reactToLit!: ReactToLit;
  @property({ attribute: false }) accessor text = "";
  @property({ attribute: false }) accessor onClick: () => void = () => {};
  @property({ attribute: false }) accessor errorMessage = "";
  @property({ attribute: false }) accessor actionText = "";
  @property({ attribute: false }) accessor actionTooltip = "";
  @property({ attribute: false }) accessor showDetailPanel = false;
  @property({ attribute: "data-testid", reflect: true }) accessor testId =
    "ai-error";

  protected override render() {
    return this.reactToLit
      ? this.reactToLit(
          createElement(ChatErrorView, {
            text: this.text,
            details: this.showDetailPanel ? this.errorMessage : undefined,
            action:
              this.actionText ||
              chatI18n()["com.myoxus.helpIsland.contactUs"](),
            tooltip: this.actionTooltip,
            onAction: this.onClick,
          }),
          true,
        )
      : nothing;
  }
}

/** All chat consumers share native error chrome and bounded server failure codes. */
export function AIChatErrorRenderer(
  error: AIError,
  host: EditorHost | null | undefined,
  reactToLit: ReactToLit,
) {
  const login = error instanceof UnauthorizedError;
  const t = chatI18n();
  const code = error instanceof GeneralNetworkError ? error.code : undefined;
  const text = login
    ? t["com.myoxus.ai.chat-panel.login-required"]()
    : code === "COPILOT_PROVIDER_TIMEOUT"
      ? t["com.myoxus.ai.chat-panel.provider-timeout"]()
      : code === "COPILOT_CONTEXT_LIMIT"
        ? t["com.myoxus.ai.chat-panel.context-too-large"]()
        : code === "COPILOT_OUTPUT_TRUNCATED"
          ? t["com.myoxus.ai.chat-panel.output-truncated"]()
          : t["com.myoxus.ai.chat-panel.error"]();
  return html`<ai-error-wrapper
    .reactToLit=${reactToLit}
    .text=${text}
    .errorMessage=${login ? "" : error.message}
    .showDetailPanel=${!login && !!error.message}
    .actionText=${login ? chatI18n()["Sign in"]() : chatI18n()["com.myoxus.helpIsland.contactUs"]()}
    .actionTooltip=${login ? "" : BUILD_CONFIG.communityUrl}
    .onClick=${() => (login ? AIProvider.slots.requestLogin.next({ host }) : window.open(BUILD_CONFIG.communityUrl, "_blank", "noopener,noreferrer"))}
  ></ai-error-wrapper>`;
}
declare global {
  interface HTMLElementTagNameMap {
    "ai-error-wrapper": AIErrorWrapper;
  }
}
