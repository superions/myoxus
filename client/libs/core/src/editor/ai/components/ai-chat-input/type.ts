// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { Signal } from "@preact/signals-core";

import type { AIError } from "../../provider";
import type { ChatContextValue } from "../ai-chat-content";
import type { ChatStatus, HistoryMessage } from "../ai-chat-messages";

export interface AIReasoningConfig {
  enabled: Signal<boolean | undefined>;
  setEnabled: (state: boolean) => void;
}

export type AIChatInputContext = {
  messages: HistoryMessage[];
  status: ChatStatus;
  error: AIError | null;
  quote?: string;
  markdown?: string;
  images: File[];
  abortController: AbortController | null;
} & Partial<
  Pick<
    ChatContextValue,
    | "snapshot"
    | "combinedElementsMarkdown"
    | "attachments"
    | "docs"
    | "html"
    | "retrievalAvailable"
  >
>;
