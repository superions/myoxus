// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { EditorHost } from "@virgultum/editor/std";

import {
  type AIPanelController,
  AIPanelControllerIdentifier,
} from "../widgets/ai-panel/controller";

export function getAIPanelController(host: EditorHost): AIPanelController {
  const controller = host.std.getOptional(AIPanelControllerIdentifier);
  if (!controller) {
    throw new Error("AI panel not found");
  }
  return controller;
}
