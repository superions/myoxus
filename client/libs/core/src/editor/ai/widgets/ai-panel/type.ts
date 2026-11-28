// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import type { ReactNode } from "react";

import type { StreamObject } from "../../components/ai-chat-messages";
import type { AIItemGroupConfig } from "../../components/ai-item/types";
import type { AIError } from "../../provider";

export interface CopyConfig {
  allowed: boolean;
  onCopy: () => boolean | Promise<boolean>;
}

export interface AIPanelAnswerConfig {
  responses: AIItemGroupConfig[];
  actions: AIItemGroupConfig[];
}

export interface AIPanelErrorConfig {
  login: () => void;
  cancel: () => void;
  responses: AIItemGroupConfig[];
  error?: AIError;
}

export interface AIPanelGeneratingConfig {
  generatingIcon: MyoxusIconExportName;
  height?: number;
  stages?: string[];
}

export type AIActionAnswer = {
  content: string;
  streamObjects?: StreamObject[];
};

export type MyoxusAIPanelState =
  "hidden" | "input" | "generating" | "finished" | "error";

export interface MyoxusAIPanelWidgetConfig {
  answerRenderer: (answer: string, state?: MyoxusAIPanelState) => ReactNode;
  generateAnswer?: (props: {
    input: string;
    update: (answer: AIActionAnswer) => void;
    finish: (type: "success" | "error" | "aborted", err?: AIError) => void;
    signal: AbortSignal;
  }) => void;
  finishStateConfig: AIPanelAnswerConfig;
  generatingStateConfig: AIPanelGeneratingConfig;
  errorStateConfig: AIPanelErrorConfig;
  hideCallback?: () => void;
  discardCallback?: () => void;
  inputCallback?: (input: string) => void;
  copy?: CopyConfig;
}
