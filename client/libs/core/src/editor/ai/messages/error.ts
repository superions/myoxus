// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

const ERROR_CODE_KEYS = {
  COPILOT_PROVIDER_TIMEOUT: "com.myoxus.ai.chat-panel.provider-timeout",
  COPILOT_CONTEXT_LIMIT: "com.myoxus.ai.chat-panel.context-too-large",
  COPILOT_OUTPUT_TRUNCATED: "com.myoxus.ai.chat-panel.output-truncated",
} as const;

type KnownCopilotCode = keyof typeof ERROR_CODE_KEYS;

function resolveErrorCopy(error: AIError): string {
  const t = chatI18n();
  if (error instanceof UnauthorizedError) {
    return t["com.myoxus.ai.chat-panel.login-required"]();
  }
  if (
    error instanceof GeneralNetworkError &&
    error.code &&
    error.code in ERROR_CODE_KEYS
  ) {
    return t[ERROR_CODE_KEYS[error.code as KnownCopilotCode]]();
  }
  return t["com.myoxus.ai.chat-panel.error"]();
}

/** Renders a localized chat error card for authentication and server-coded AI failures. */
export function AIChatErrorRenderer(
  error: AIError,
  host: EditorHost | null | undefined,
) {
  const t = chatI18n();
  const needsSignIn = error instanceof UnauthorizedError;
  return createElement(ChatErrorView, {
    text: resolveErrorCopy(error),
    details: needsSignIn ? undefined : error.message,
    action: needsSignIn
      ? t["Sign in"]()
      : t["com.myoxus.helpIsland.contactUs"](),
    tooltip: needsSignIn ? undefined : BUILD_CONFIG.communityUrl,
    onAction: () => {
      if (needsSignIn) {
        AIProvider.slots.requestLogin.next({ host });
      } else {
        window.open(BUILD_CONFIG.communityUrl, "_blank", "noopener,noreferrer");
      }
    },
  });
}
