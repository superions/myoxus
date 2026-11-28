// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { type ActionEventType, AIProvider } from "../provider";

export function reportResponse(event: ActionEventType): void {
  const latest = AIProvider.actionHistory.at(-1);
  if (!latest) return;

  AIProvider.slots.actions.next({
    action: latest.action,
    options: latest.options,
    event,
  });
}
