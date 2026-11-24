// SPDX-License-Identifier: MIT
import type { EditorHost } from "@virgultum/editor/std";
import { createElement } from "react";
import { chatI18n } from "../components/chat-i18n";
import {
  type AIError,
  AIProvider,
  GeneralNetworkError,
  UnauthorizedError,
} from "../provider";
import { ChatErrorView } from "./error-view";

/** All chat consumers share native error chrome and bounded server failure codes. */
export function AIChatErrorRenderer(
  error: AIError,
  host: EditorHost | null | undefined,
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
  return createElement(ChatErrorView, {
    text,
    details: login ? undefined : error.message,
    action: login ? t["Sign in"]() : t["com.myoxus.helpIsland.contactUs"](),
    tooltip: login ? undefined : BUILD_CONFIG.communityUrl,
    onAction: () => {
      if (login) AIProvider.slots.requestLogin.next({ host });
      else
        window.open(BUILD_CONFIG.communityUrl, "_blank", "noopener,noreferrer");
    },
  });
}
