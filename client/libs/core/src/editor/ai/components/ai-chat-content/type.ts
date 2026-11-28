// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { AIError } from "../../provider";
import type { ChatStatus, HistoryMessage } from "../ai-chat-messages";

export type ChatContextValue = {
  messages: HistoryMessage[];
  status: ChatStatus;
  /** Reflects retrieval availability from the most recent owned request. */
  retrievalAvailable?: boolean;
  error: AIError | null;
  quote: string;
  markdown: string;
  images: File[];
  snapshot: string | null;
  attachments: { sourceId: string; name: string }[];
  combinedElementsMarkdown: string | null;
  docs: string[];
  html: string | null;
  abortController: AbortController | null;
};
