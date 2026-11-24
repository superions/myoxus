// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

export const reviewCodeActions = [
  {
    name: "Explain this code",
    testId: "action-explain-code",
    iconName: "ExplainIcon",
    command: "explainCode",
  },
  {
    name: "Check code error",
    testId: "action-check-code-error",
    iconName: "ExplainIcon",
    command: "checkCodeErrors",
  },
] as const;

export const continueInChat = {
  name: "Continue in AI Chat",
  testId: "action-continue-with-ai",
  iconName: "CommentIcon",
} as const;
